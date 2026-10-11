# step-progress-loader.ps1 - Step 진행 상태 로드 (SessionStart)
# 새 세션 시작 시 이전 진행 상태를 로드하여 컨텍스트에 주입
param()

$harnessRaw = ""
$harnessEvent = $null
try {
    $harnessReader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
    $harnessRaw = $harnessReader.ReadToEnd()
    $harnessReader.Close()
    if ($harnessRaw) { $harnessEvent = $harnessRaw | ConvertFrom-Json -ErrorAction Stop }
} catch {}


$ErrorActionPreference = "Continue"
# PowerShell 5.1 writes stdout in the console code page (cp949 on Korean Windows), so '완료' in
# the output reached Claude garbled. Emit UTF-8 like trust5-validator.ps1.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
$projectRoot = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } elseif ($harnessEvent.cwd) { [string]$harnessEvent.cwd } else { [System.IO.Directory]::GetCurrentDirectory() }
$stepArchive = Join-Path $projectRoot "step_archive"
$progressFile = Join-Path $stepArchive "progress.json"

# F7 fix (2026-06-10): progress.json 쓰기를 writer와 동일 규약으로 통일 —
# 동일 mutex + temp 파일 + BOM 제거 + 원자적 rename (구버전은 BOM 포함·비원자·무락이라
# 병렬 훅과의 torn-write 가능성이 있었음)
function Write-ProgressAtomic($obj) {
    $mutex = New-Object System.Threading.Mutex($false, "Global\step-progress-writer-mutex")
    $acquired = $false
    try { $acquired = $mutex.WaitOne(5000) } catch {}
    if (-not $acquired) { $mutex.Dispose(); return }
    try {
        $json = $obj | ConvertTo-Json -Depth 32
        if ([string]::IsNullOrWhiteSpace($json) -or $json -eq 'null') { return }
        $tempFile = "$progressFile.tmp.$PID"
        $json | Out-File -LiteralPath $tempFile -Encoding UTF8 -Force
        $bytes = [System.IO.File]::ReadAllBytes($tempFile)
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
            [System.IO.File]::WriteAllBytes($tempFile, $bytes[3..($bytes.Length - 1)])
        }
        Move-Item -LiteralPath $tempFile -Destination $progressFile -Force
    } catch {
        Write-Host "WARNING: progress.json write failed: $_"
    } finally {
        if ($acquired) { try { $mutex.ReleaseMutex() } catch {} }
        $mutex.Dispose()
    }
}

# Codex coexistence: step_archive/.harness50-codex/state.json means the Codex state manager
# owns this workspace. Print one read-only context line (lib/codex-workflow.mjs) and leave
# progress.json alone: no creation, migration or session count. Without that file the
# legacy path below runs unchanged.
$codexState = Join-Path (Join-Path $stepArchive ".harness50-codex") "state.json"
if (Test-Path -LiteralPath $codexState) {
    $codexLine = ""
    if (Get-Command node -ErrorAction SilentlyContinue) {
        # Capture into a variable (piping native output into Select-Object -First stops node in PS 5.1).
        # The trailing "." keeps PS 5.1 from quoting a trailing backslash into the argument.
        try {
            $codexOut = @(& node (Join-Path $PSScriptRoot "lib/codex-workflow.mjs") (Join-Path $projectRoot ".") 2>$null)
            if ($codexOut.Count -gt 0) { $codexLine = [string]$codexOut[0] }
        } catch {}
    }
    if (-not $codexLine) { $codexLine = "[HARNESS] WARNING: step_archive/.harness50-codex/state.json exists but is unreadable or incomplete - Claude hooks will not create progress.json or block Stop here. Inspect it with the harness14 plugin's codex/scripts/harness-state.mjs show and ask the user before repairing or resetting it." }
    Write-Host $codexLine
    exit 0
}

# The loader never creates progress.json or step_archive/: only an explicit /webapp <topic>
# starts a run (webapp-trigger). Without a progress file there is nothing to resume.
if (-not (Test-Path -LiteralPath $progressFile -PathType Leaf)) { exit 0 }
# Resolve profile/count/body identity before reading or mutating this run.
$profileJson = @(& node (Join-Path $PSScriptRoot 'lib/workflow-profile.mjs') resolve (Join-Path $projectRoot '.') 2>$null)
if ($LASTEXITCODE -ne 0 -or $profileJson.Count -eq 0) { exit 0 }
try { $selectedProfile = ($profileJson -join "`n") | ConvertFrom-Json -ErrorAction Stop } catch { exit 0 }
$selectedArchive = Join-Path $projectRoot $selectedProfile.body_directory

try { $existingProgress = Get-Content -LiteralPath $progressFile -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop } catch { exit 0 }
if ($null -eq $existingProgress) { exit 0 }

# Named pause (harness-rules 2-1). Only scripts/harness-pause.mjs sets or clears it. While it is set
# this hook writes nothing (no session count, no migration) and prints where the run stopped
# instead of the resume instructions. Same judgement as scripts/lib/pause-state.mjs isPaused; the
# code list, template and NAMED sentence match step-progress-loader.sh and step-obedience-guard
# (in $namedPause the single quote is doubled here).
$pauseCodes = @('permission-denied', 'required-tool-failed', 'required-input-missing', 'user-request')
$pausedTemplate = '[HARNESS] PAUSED at step{STEP}/{TOTAL} (reason={REASON}{SINCE}). Automatic continuation is off: do not run steps. Tell the user why (pause_note in step_archive/progress.json) and handle their message. Resume only when the user explicitly asks: /harness-resume.'
$namedPause = 'Early stop only as a named pause (permission-denied | required-tool-failed | required-input-missing; harness-rules 2-1): save evidence under step_archive/, run node "<plugin-root>/scripts/harness-pause.mjs" pause --workspace "<project-root>" --reason <code> --evidence <step_archive/file> --note ''<user action, no quotes>'', then end the turn with the pause report.'
$hasPaused = @($existingProgress.PSObject.Properties.Name) -ccontains 'paused'
$isPaused = ($hasPaused -and -not ($existingProgress.paused -is [bool] -and -not $existingProgress.paused)) -or ($existingProgress.status -is [string] -and $existingProgress.status -ceq 'paused')
if ($isPaused) {
    $pauseTotal = 0
    try { $pauseTotal = [int]$existingProgress.total_steps } catch {}
    $pauseDone = @($existingProgress.completed_steps)
    $pauseFirst = 0
    for ($i = 1; $i -le $pauseTotal; $i++) { if ($pauseDone -notcontains $i) { $pauseFirst = $i; break } }
    if ($pauseFirst -gt 0) {
        $pauseStep = $pauseFirst
        $pausedStepValue = $existingProgress.paused_step
        # max(paused_step, first unfinished): the Stop writer records the completions of the turn
        # that paused after the pause itself (scripts/lib/pause-state.mjs pausedStep).
        if (($pausedStepValue -is [int] -or $pausedStepValue -is [long]) -and $pausedStepValue -ge 1 -and $pausedStepValue -le $pauseTotal -and $pausedStepValue -gt $pauseFirst) { $pauseStep = [int]$pausedStepValue }
        $pauseCode = 'unknown'
        if ($existingProgress.pause_reason -is [string] -and $pauseCodes -ccontains $existingProgress.pause_reason) { $pauseCode = $existingProgress.pause_reason }
        $pauseSince = ''
        if ($existingProgress.paused_at -is [string] -and $existingProgress.paused_at -cmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z\z') { $pauseSince = ', since ' + $existingProgress.paused_at }
        $pausedLine = $pausedTemplate.Replace('{STEP}', ('{0:D3}' -f $pauseStep)).Replace('{TOTAL}', [string]$pauseTotal).Replace('{REASON}', $pauseCode).Replace('{SINCE}', $pauseSince)
        Write-Host "=== Paused at step$('{0:D3}' -f $pauseStep) ==="
        Write-Host $pausedLine
        exit 0
    }
}

Write-Host "=== Step Progress Loader ==="

# Count only the selected profile archive. Legacy runs also allow the historic flat layout.
$stepFiles = @()
if ($selectedProfile.workflow_profile -eq 'legacy-50-v1') {
    $stepFiles += @(Get-ChildItem -LiteralPath $stepArchive -Filter "step???.md" -ErrorAction SilentlyContinue)
}
$archivedDir2 = $selectedArchive
if (Test-Path -LiteralPath $archivedDir2) {
    $stepFiles += @(Get-ChildItem -LiteralPath $archivedDir2 -Filter "step???.md" -ErrorAction SilentlyContinue)
}
$actualTotal = @($stepFiles | ForEach-Object { $_.Name } | Sort-Object -Unique).Count
$needsRewrite = $false
# Report only: rewriting total_steps could turn an inactive run active (or the reverse).
if ($actualTotal -gt 0 -and $actualTotal -ne [int]$existingProgress.total_steps) {
    Write-Host "WARNING: total_steps mismatch (progress.json=$($existingProgress.total_steps), filesystem=$actualTotal)."
}

# MoAI-ADK 벤치마킹: 누락 필드 자동 추가 (마이그레이션)
if (-not $existingProgress.PSObject.Properties.Name.Contains('moai_features')) {
    $existingProgress | Add-Member -NotePropertyName 'moai_features' -NotePropertyValue ([PSCustomObject]@{ spec_generated_count=0; mx_tag_warnings=0; lsp_autofixes=0 }) -Force
    $needsRewrite = $true
}
if ($needsRewrite) {
    Write-ProgressAtomic $existingProgress
}

# F7 fix: 인코딩 미지정 재읽기(자기 torn-read 윈도우) 제거 — 이미 파싱된 객체 재사용
$progress = $existingProgress

$completedCount = $progress.completed_steps.Count
$failedCount = $progress.failed_steps.Count
$totalSteps = $progress.total_steps

# F3 fix (2026-06-10): 표시 step도 아래 복종 블록과 동일한 first-gap 규칙으로 계산 —
# 한 SessionStart가 서로 다른 두 step 번호를 출력하던 불일치 제거
$completedArr0 = @($progress.completed_steps)
$currentStep = [int]$progress.total_steps
for ($i = 1; $i -le [int]$progress.total_steps; $i++) {
    if ($completedArr0 -notcontains $i) { $currentStep = $i; break }
}

Write-Host "Progress: $completedCount/$totalSteps completed"
Write-Host "Current step: step$('{0:D3}' -f $currentStep)"
Write-Host "Failed steps: $failedCount"

if ($failedCount -gt 0) {
    Write-Host "Failed step list: $($progress.failed_steps -join ', ')"
}

# 세션 카운터 증가
$progress.metrics.total_sessions = $progress.metrics.total_sessions + 1
$sessionEntry = @{
    session_id = $progress.metrics.total_sessions
    started_at = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')
    starting_step = $currentStep
}

$sessionList = @($progress.session_history) + @($sessionEntry)
$progress.session_history = $sessionList
$progress.last_updated = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')

Write-ProgressAtomic $progress

Write-Host "Session #$($progress.metrics.total_sessions) started"
Write-Host "=== Ready to resume from step$('{0:D3}' -f $currentStep) ==="

# ── 복종 지시 ──────────────────────────────────────────────────────────────
# 다음 실행해야 할 step 파일 경로를 명확히 못박아 모델에 주입.
# step001.md 끝의 "즉시 다음 step 읽고 실행" 지시를 다른 세션에서도 강제한다.
$archivedDir = $selectedArchive
$nextStep = $null
$completedArr = @($progress.completed_steps)
for ($i = 1; $i -le [int]$progress.total_steps; $i++) {
    if ($completedArr -notcontains $i) { $nextStep = $i; break }
}
if ($null -ne $nextStep) {
    $nextStepFmt = "step$('{0:D3}' -f $nextStep)"
    # F9 fix (2026-06-10): archived/ 우선, flat 폴백 이중 해석 (auto-continue와 동일 규약)
    $nextStepRel = $null
    if (Test-Path -LiteralPath (Join-Path $archivedDir "$nextStepFmt.md")) {
        $nextStepRel = "$($selectedProfile.body_directory)/$nextStepFmt.md"
    } elseif (Test-Path -LiteralPath (Join-Path $stepArchive "$nextStepFmt.md")) {
        $nextStepRel = "step_archive/$nextStepFmt.md"
    }
    if ($nextStepRel) {
        Write-Host ""
        Write-Host "=== HARNESS OBEDIENCE ==="
        Write-Host "Your first action this session is to Read $nextStepRel, unless the user sent an explicit direct request (user direct requests take priority — CLAUDE.md ABSOLUTE OVERRIDE exception)."
        Write-Host "Do not greet the user. Do not ask what to do."
        Write-Host "Read $nextStepFmt.md, execute it, then move to the next step."
        Write-Host "Each step file ends with 'Read step(N+1).md immediately upon completion'; obey that chain."
        Write-Host $namedPause
    }
}
exit 0
