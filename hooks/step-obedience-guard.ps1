# step-obedience-guard.ps1 - 매 user prompt마다 미완료 step 리마인더 주입
# UserPromptSubmit hook으로 사용.
# 미완료 step이 있으면 다음 step 경로를 컨텍스트에 주입해 하네스 복귀를 유도한다.
# 단, 사용자의 명시적 직접 요청은 우선한다 (2026-06-10 A5-07 방향 확정:
# CLAUDE.md ABSOLUTE OVERRIDE에 동일한 예외 조항을 명문화 — 실사용 패턴 근거).

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

# Codex coexistence: no Claude step reminder while the Codex state manager owns this workspace.
if (Test-Path -LiteralPath (Join-Path (Join-Path $stepArchive ".harness50-codex") "state.json")) { exit 0 }

# The commands that control the run itself (/harness-pause, /harness-resume, /harness-status,
# /harness-reset) get no reminder, paused or not.
if ([string]$harnessEvent.prompt -cmatch '^\s*/(harness(14|20|36|50):)?harness-(pause|resume|status|reset)(\s|$)') { exit 0 }

if (-not (Test-Path -LiteralPath $progressFile)) { exit 0 }

# Resolve profile/count/body identity before reading or mutating this run.
$profileJson = @(& node (Join-Path $PSScriptRoot 'lib/workflow-profile.mjs') resolve (Join-Path $projectRoot '.') 2>$null)
if ($LASTEXITCODE -ne 0 -or $profileJson.Count -eq 0) { exit 0 }
try { $selectedProfile = ($profileJson -join "`n") | ConvertFrom-Json -ErrorAction Stop } catch { exit 0 }
$selectedArchive = Join-Path $projectRoot $selectedProfile.body_directory

try {
    $progress = Get-Content -LiteralPath $progressFile -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    exit 0
}

$totalSteps = [int]$progress.total_steps
$completed = @($progress.completed_steps)
$completedCount = $completed.Count

# 모든 step 완료 → 신규 요청 자유 처리
if ($completedCount -ge $totalSteps) { exit 0 }

# 다음 실행해야 할 step 번호 결정
$nextStep = $null
for ($i = 1; $i -le $totalSteps; $i++) {
    if ($completed -notcontains $i) { $nextStep = $i; break }
}
if ($null -eq $nextStep) { exit 0 }

# Named pause (harness-rules 2-1): one line saying where the run stopped, no step reminder. Same
# judgement, code list and template as step-progress-loader (scripts/lib/pause-state.mjs).
$pauseCodes = @('permission-denied', 'required-tool-failed', 'required-input-missing', 'user-request')
$pausedTemplate = '[HARNESS] PAUSED at step{STEP}/{TOTAL} (reason={REASON}{SINCE}). Automatic continuation is off: do not run steps. Tell the user why (pause_note in step_archive/progress.json) and handle their message. Resume only when the user explicitly asks: /harness-resume.'
$hasPaused = @($progress.PSObject.Properties.Name) -ccontains 'paused'
$isPaused = ($hasPaused -and -not ($progress.paused -is [bool] -and -not $progress.paused)) -or ($progress.status -is [string] -and $progress.status -ceq 'paused')
if ($isPaused) {
    # An explicit /webapp <topic> is answered by webapp-trigger, which runs for the same prompt (in
    # parallel): it starts a new topic when no step is complete, else says why not. A PAUSED line
    # here would contradict that answer.
    if ([string]$harnessEvent.prompt -cmatch '^[ \t]*/(harness(14|20|36|50):)?webapp[ \t]+\S') { exit 0 }
    $pauseTotal = $totalSteps
    $pauseFirst = $nextStep
    $pauseStep = $pauseFirst
    $pausedStepValue = $progress.paused_step
    # max(paused_step, first unfinished): the Stop writer records the completions of the turn that
    # paused after the pause itself (scripts/lib/pause-state.mjs pausedStep).
    if (($pausedStepValue -is [int] -or $pausedStepValue -is [long]) -and $pausedStepValue -ge 1 -and $pausedStepValue -le $pauseTotal -and $pausedStepValue -gt $pauseFirst) { $pauseStep = [int]$pausedStepValue }
    $pauseCode = 'unknown'
    if ($progress.pause_reason -is [string] -and $pauseCodes -ccontains $progress.pause_reason) { $pauseCode = $progress.pause_reason }
    $pauseSince = ''
    if ($progress.paused_at -is [string] -and $progress.paused_at -cmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z\z') { $pauseSince = ', since ' + $progress.paused_at }
    $pausedLine = $pausedTemplate.Replace('{STEP}', ('{0:D3}' -f $pauseStep)).Replace('{TOTAL}', [string]$pauseTotal).Replace('{REASON}', $pauseCode).Replace('{SINCE}', $pauseSince)
    Write-Output $pausedLine
    exit 0
}

$nextStepFmt = "step$('{0:D3}' -f $nextStep)"
$archivedDir = $selectedArchive
# F9 fix (2026-06-10): archived/ 우선, flat 폴백 이중 해석 (auto-continue와 동일 규약)
$nextStepRel = $null
if (Test-Path -LiteralPath (Join-Path $archivedDir "$nextStepFmt.md")) {
    $nextStepRel = "$($selectedProfile.body_directory)/$nextStepFmt.md"
} elseif (Test-Path -LiteralPath (Join-Path $stepArchive "$nextStepFmt.md")) {
    $nextStepRel = "step_archive/$nextStepFmt.md"
}

# 어느 쪽에도 파일이 존재하지 않으면 silent skip
if (-not $nextStepRel) { exit 0 }

# Claude Code는 stdout을 system-reminder로 모델 컨텍스트에 주입한다.
# stderr 사용 시 hook error로 차단되므로 stdout만 사용.
Write-Output "[HARNESS] $completedCount/$totalSteps done. Next: $nextStepRel (read+execute, no user confirmation). User direct requests still take priority."

exit 0
