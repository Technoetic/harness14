# harness14 for Codex

Harness14의 Codex 어댑터는 기획부터 시작하는 기본14 절차를 14개의 검증 가능한 단계로 실행하되, Codex의 정상 권한 확인과 명시적인 후크 신뢰 절차를 유지합니다. Claude Code 설치와 기존 동작은 [루트 안내서](../README.md)를 참고하세요.

## Workflow profiles / 새14와 기존20·36·50

공개 저장소·플러그인·마켓플레이스 ID는 모두 **harness14**입니다.
시작 명령은 `/harness14:webapp`·`$harness14:webapp`이며, 새 실행은 schema2
`planning-first-14-v1`의 **14단계**를 사용합니다. 이전 기본20의 step3–8을
독립 단계에서 제거하고 환경 준비는 설계2의 마지막으로, 작업 단위 소유권과
UTF-8 무BOM·LF 작성 규칙은 구현3으로, 실제 바이트 검사는 빌드4로 옮겼습니다.
설계의 독립 PASS 이후에만 환경 준비를 수행하며, 환경 보고서·유효한 브라우저
잠금·실제 준비 증거가 없으면 구현에 진입하지 않습니다. 의존성 설치는 필요한
선언 항목에 한해 정상 권한 흐름으로 수행합니다.

TOPIC의 사용자 원문·여섯 필드와 해시는 유지합니다. 없는 API 계약이나 입력은
누락으로 남기며, 기획·설계가 현재 외부 사실을 확인했다고 추정하지 않습니다.
Codex는 `begin.step_target`, Claude는 resolver의 `step_body`를 읽습니다.
새 본문은 `assets/profiles/planning-first-14-v1/steps/`와
`codex/assets/profiles/planning-first-14-v1/steps/`, Claude 보관 본문은
`step_archive/profiles/planning-first-14-v1/archived/`에 있습니다.

기존 `planning-first-20-v1`, `research-free-36-v1`, `legacy-50-v1`과
미표식 schema-v1의50단계 실행은 번호·본문·해시·pause/resume·완료 영수증을
유지합니다. 새 기본값으로 기존 실행을 재해석하지 않습니다. Codex reset 이후
새 시작은14를 선택하고, Claude reset은 기존 실행의 선택 프로필을 보존합니다.
손상된 상태나 바인딩은 일관된 기록을 복원한 뒤 진행합니다.

| 새 단계 | 원번호 | 역할 |
| --- | --- | --- |
| 1 | 25 | 요구사항 기획 |
| 2 | 30 | 통합 설계·독립 PASS 후 환경 준비·브라우저 잠금 |
| 3 | 37 | 작업 단위 소유권 선언·구현·인코딩 규칙 |
| 4 | 38 | 빌드·바이트 검사·품질1 |
| 5 | 39 | 독립 레이아웃 검증 |
| 6 | 41 | JavaScript 모듈 분리 |
| 7 | 42 | CSS 분리 |
| 8 | 44 | 라우팅 통합·품질2 |
| 9 | 45 | E2E |
| 10 | 46 | 독립 스크린샷 E2E |
| 11 | 47 | 독립 키보드 검증 |
| 12 | 48 | 독립 마우스 검증 |
| 13 | 49 | 최종 설계 검증 |
| 14 | 50 | 최종 빌드·전체 회귀·품질3 |

품질은 **4·8·14**, 독립 QA는 **5·10·11·12**, Jev는 **1·2·3·9·13**입니다.
기존20의 품질10·14·20과 QA11·16·17·18, 기존36/50 좌표는 유지합니다.
필수 finding, 최대5라운드와 접근성·키보드·마우스·회귀 기준도 유지합니다.

현재 브라우저 검증기는 생성 HTML의 호스트 네트워크 격리 어댑터가 없으면
`FAIL`로 차단합니다. 이 제약을 단계 축소로 해제하지 않습니다. 상태 기계의
합성14/14 시험은 실제 브라우저·실모델·배포 완료의 증거가 아닙니다.

### Tower에서 가져온 실행 비교 기능

명시적 오프라인 도구 [workflow-trials](../docs/workflow-trials.md)는 실행 조건과
선택 근거를 고정하고, 같은 조건의 baseline/candidate 관측을 비교하며, 민감한
본문을 제외한 현재 Codex 영수증 구조를 추출합니다. QA·근거가 낡았거나 한쪽
관측이 없거나 중대한 오류가 있으면 비교를 보류합니다. 기록된 수치는 호출자가
관측한 값이며, 도구 자체가 모델을 실행하거나 업무 효과를 측정하지 않습니다.
비교 결과는 기존 품질·QA·완료 판정의 권한을 대신하지 않습니다.

## Host commands / 호스트 명령

| Host | Start | Status | Reset |
|---|---|---|---|
| Claude Code | `/harness14:webapp <topic>` | `/harness14:harness-status` | `/harness14:harness-reset` |
| Codex | `$harness14:webapp <topic>` | `$harness14:harness14-status` | `$harness14:harness14-reset` |

짧은 이름도 사용할 수 있습니다: Claude Code의 `/webapp`, `/harness-status`, `/harness-reset`과 Codex의 `$webapp`, `$harness14-status`, `$harness14-reset`. 각 시작 명령에는 주제를 붙입니다.

Codex does not provide a `/webapp` slash command. 진행 중인 Codex 워크플로를 이어가려면 `$webapp resume`, 자동 이어가기를 일시 정지하려면 `$webapp pause`를 사용하세요.

플러그인 이름을 포함한 `$harness14:webapp`, `$harness14:harness14-status`, `$harness14:harness14-reset`도 지원합니다. 하위 에이전트의 요청은 부모 워크플로를 일시정지하지 않습니다.

Codex는 설치할 때 Claude Code `commands/*.md`의 일부를 `source-command-<이름>` 스킬로 바꿔 플러그인 캐시(`.codex-plugin/migrated-command-skills/`)에 둘 수 있습니다. 이 변환은 호스트 동작이며, 어떤 명령이 바뀌는지는 Codex 버전과 명령 내용에 따라 다릅니다(관측: 2.10.0 설치에서는 reset·resume, 2.9.0에서는 reset·status). Codex에서는 위 표의 스킬과 `$webapp pause`·`$webapp resume`을 사용하세요. 이관된 스킬이 선택되어도 다섯 Claude 명령은 모두 Codex 작업 공간(`step_archive/.harness50-codex/state.json`)을 먼저 확인하므로, 그 공간에서는 Claude `progress.json`과 TOPIC을 만들거나 바꾸지 않고, Codex 명령을 안내하거나 Codex 상태 관리자 절차를 따릅니다.

## Jev-first direct questions

When requested, Jev-first applies to every eligible typed judgment, including chat
and arithmetic outside the selected workflow checkpoints. Standing authorization for
selected ordinary nonsecret input is reused without a prompt for every question.
The webapp skill also activates for a direct Jev question or an authorized standing
Jev-first preference; no `$webapp` start command or workflow initialization is needed.
The direct `scripts/jev-ask.mjs prepare|run --input -` CLI needs no workflow or source
file; `run` also requires `--allow-network`. It preserves native Noul, abstaining
Choice and ordered-rubric Score results. File-derived reviews retain their existing
source-bound adapters and reports. Free generation, observation and actual tools
remain host work; unsupported or unavailable results receive a visible fallback
reason. No Jev result completes a step or replaces required tests or permissions.
See the [direct question guide](../docs/jev-first.md) for the JSON contract and limits.

## Codex installation / 설치

### Local checkout

현재 브랜치의 Codex 지원을 확인하려면 저장소를 체크아웃한 뒤 그 루트를 로컬 마켓플레이스로 등록합니다.

```text
codex plugin marketplace add <path-to-harness14>
codex plugin add harness14@harness14
```

### GitHub source

공개 저장소에서 다음 경로로 설치할 수 있습니다.

```text
codex plugin marketplace add Technoetic/harness14
codex plugin add harness14@harness14
```

The published repository includes both Claude Code and Codex adapters. 어느 경로를 사용하든 설치만으로 후크가 신뢰되지는 않습니다.

### Remove / 제거

```text
codex plugin remove harness14@harness14
```

이 명령은 로컬 설정과 캐시에서 플러그인을 지웁니다. 마켓플레이스 등록까지 지우려면 이어서 `codex plugin marketplace remove harness14`을 실행합니다. 진행 중인 워크플로는 캐시 안의 `codex/scripts/harness-state.mjs`를 쓰므로, 제거하거나 `codex plugin add`로 갱신하기 전에 `$webapp pause`로 멈추거나 워크플로를 완료하세요. 갱신도 이전 버전의 캐시를 지웁니다.

## Permissions and continuation / 권한과 이어가기

- Normal Codex permission confirmations remain in effect for every command.
- Harness14 never auto-approves commands and never changes sandbox or approval settings.
- Each later turn receives at most one one-step continuation marker; that marker schedules work but grants no permission.
- Submitted command evidence is validated only as a string and exit status; the Harness14 runtime never executes that submitted command.
- The guard is a bounded, deny-only defense, not a shell sandbox; benign commands are never approved by the hook and still follow normal Codex permissions.

`$webapp <주제>` 한 번으로 현재 대화에서 순차 실행을 시작합니다. 한 작업 단위에서는
상태 관리자가 선택한 단계 하나만 수행하고, 증거를 제출해 `complete`가 성공하면 반환된
현재 단계와 마커로 다음 작업 단위를 바로 시작합니다. 중간 완료는 진행 메시지로 알리며
단계마다 최종 응답을 보내거나 재입력을 요구하지 않습니다. 같은 주제로 기존 작업이 있으면
완료 기록을 보존한 채 재개 절차를 수행합니다.

한 줄 요청만으로 시작할 수 있습니다. `init`이 여섯 주제 필드와 명시된 기본값을 준비하고
전체 원문을 보존한 뒤 해시를 고정합니다. 사용자가 내부 필드 이름을 작성할 필요는 없습니다.
현재 대화에서 진행하는 데 Stop 후크는 필요하지 않습니다. 훅을 실행하거나 신뢰 설정을
바꾸는 대신 기존 상태 관리자의 정식 명령만 사용합니다. 전체 완료, 사용자 일시정지,
실제 권한·외부 입력 대기, 관리자 차단 상태에서는 멈춥니다. 복구 가능한 실패는 같은
단계에서 새 마커로 재시도하되, 연속 3회 실패 제한을 `resume`으로 초기화하지 않습니다.
외부 입력 대기로 대화를 끝내야 하면 실행 중인 상태를 `pause`로 저장해 같은 대기의
자동 반복을 막습니다. 현재 대화에서 처리 중인 일반 도구 권한 확인은 그대로 기다립니다.
호스트가 대화를 강제로 종료한 뒤의 자동 재개는 별도이며, 신뢰된 Stop 후크와 실제
호스트 전달이 필요합니다. 앱 종료·사용량 제한 이후의 무인 재시작을 보장하지 않습니다.

구버전에서 한 줄 입력이 그대로 고정돼 Step 1이 실패했다면 `$webapp resume`은 먼저
`repair-topic --workspace "<project-root>"`를 적용할 수 있습니다. 이 명령은 새 주제를
받지 않고 기존 해시와 원문을 검증해 누락된 항목만 보완합니다. 원문은 백업으로 남고
워크플로는 1단계의 일시정지 상태가 되며, 이어서 `resume`으로 새 시도를 시작합니다.
완료 기록이나 가져온 이력이 있거나 실행 중인 시도가 미완료이면 복구하지 않습니다.
이 조건을 만족하는 첫 단계 재개에서는 TOPIC의 겉모양과 관계없이 관리자에게 복구 여부를
판단하게 합니다. 복구 중 TOPIC 저장 직후 중단돼도 재시도로 상태 해시를 연결할 수 있습니다.
정상적인 기존 TOPIC은 변경하지 않으며, 실제 호스트의 후크 신뢰 설정도 변경하지 않습니다.

## Migration and reset / 마이그레이션과 리셋

### harness20 → harness14 설치 전환

v4.2.1은 설치 ID와 현재 명령 namespace를 `harness14`로 맞춥니다. 새 설치의 시작 명령은 `$harness14:webapp`이며, 상태·리셋 스킬은 `$harness14-status`와 `$harness14-reset`입니다. 기존 `harness20` 설치를 같은 범위에서 비활성화한 뒤 새 ID를 등록하세요. 프로젝트별 비활성 설정과 구버전 캐시는 유지하고 두 ID를 동시에 활성화하지 않습니다. 새로운 스킬 목록은 새 호스트 세션에서 확인합니다.

작업 상태 경로 `step_archive/.harness50-codex/`, 기존 프로필과 단계 본문, 환경 보고 marker 및 공용 Jev 장부는 그대로 사용합니다. 아래 v4.0.0 전환은 당시 설치 이름에 관한 기록입니다.

### harness36 → harness20 설치 전환

v4.0.0은 설치 ID와 명령 namespace를 `harness20`으로 바꿉니다. 기존 `harness36` 또는 `harness50` 설치가 자동으로 개명되지는 않습니다. 진행 중인 실행은 먼저 일시 정지하고, 기존 플러그인을 해당 설치 범위에서 비활성화한 뒤 새 `harness20`을 설치·활성화하세요. 두 이름의 플러그인을 동시에 활성화하지 마세요. 이전에 특정 프로젝트에서 꺼 둔 설정은 새 이름에서도 유지합니다. v3.0.0의 `harness50`→`harness36` 전환 이력은 루트 안내서의 과거 절에 보존합니다.

기존 플러그인 캐시는 롤백과 다른 프로젝트를 위해 보존합니다. 전환 중에는 기존 설치를 제거하거나 캐시 폴더를 개명하지 않습니다. `step_archive/.harness50-codex/`, Claude 진행 기록, TOPIC, 단계 본문과 산출물은 이동·개명 없이 이어서 사용합니다. 기존 36/50 실행의 프로필과 계약 식별자도 유지합니다. 새 설치 후 호스트를 다시 시작하고 Codex의 변경된 훅 정의는 직접 검토·신뢰해야 합니다.

사용자 공용 Jev 장부 `~/.harness36-security/jev-budget`과 기존 `HARNESS36_JEV_BUDGET_ROOT`는 유지합니다. 개명으로 호출·입력 예약 한도를 초기화하지 않습니다. 생성 HTML의 네이티브 브라우저 실행은 전체 전송 격리가 지원될 때까지 거부되며, 설치 여부나 가용성 probe가 격리를 증명하지 않습니다. 통제와 한계는 [보안 안내](../docs/SECURITY.md)를 따릅니다.


- Only when no Codex workflow exists, existing Claude progress may be imported read-only once.
- Codex never writes back to Claude progress and never merges later Claude changes.
- Reset archives and deactivates only Codex control metadata.
- Reset preserves Claude progress, TOPIC, shared outputs, project source, and application source.

가져온 Claude 완료 기록은 `imported`, Codex가 새로 검증한 완료 기록은 `codex_verified`로 구분됩니다. `$harness14-reset`은 복구 가능한 백업 경로를 보고하고 자동으로 새 워크플로를 시작하지 않습니다.
가져오기나 영수증 복구 결과가 이미 `completed`라면 이 구분을 유지해 결과를 보고하며,
완료된 작업에 다시 `resume`을 호출하지 않습니다.

Claude Code hooks defer to an existing Codex workflow. While `step_archive/.harness50-codex/state.json` exists, they never create, rewrite or advance Claude `progress.json`, never block Stop, never auto-approve Claude edits and never re-initialize TOPIC; SessionStart reports the Codex step in one line instead. The two Claude guards still check Bash commands there, because a Claude session has no other Harness14 guard in a Codex workspace.
같은 작업 공간을 Claude Code에서 열어도 진행 기준은 Codex 상태 관리자입니다. 이어서 진행하려면 `codex/skills/webapp/SKILL.md`의 상태 관리자 절차(`show`·`resume`·`begin`·`complete`)를 따르며, 대화 속 완료 보고는 단계를 진행시키지 않습니다. 리셋 뒤 `state.json`이 백업으로 옮겨지면 Claude 훅은 기존 동작으로 돌아갑니다.

## Hook trust gate / 후크 신뢰 게이트

1. Start a fresh Codex session after installation and verify that all three skills are visible.
2. Open `/hooks` and inspect the exact installed `codex/hooks/hooks.json` definition and its four synchronous handlers: `PreToolUse`, `SessionStart`, `UserPromptSubmit`, and `Stop`.
3. Confirm that no approval hook is present, then manually trust only those exact current definitions.
4. Changed hook hashes require review and manual trust again; never bypass or automate this trust step.

확인할 세 스킬은 `$webapp`, `$harness14-status`, `$harness14-reset`입니다. Codex가 Claude 명령에서 옮긴 `source-command-*` 스킬은 이 세 스킬에 포함되지 않습니다. Hook execution stops at this trust gate until the user confirms the review. 설치 자동화가 훅 신뢰를 대신 처리해서는 안 됩니다. 스킬의 현재 대화 내 순차 실행은 훅을 실행하지 않으므로 이 신뢰 조작을 요구하지 않습니다.

### When the workflow waits after every step / 매 단계 대기할 때

이전 스킬은 단계마다 종료하고 Stop 후크를 기다렸기 때문에, 후크가 신뢰되지 않으면
매 단계 대기했습니다. 최신 스킬은 성공한 작업 단위 뒤 같은 대화에서 계속 진행합니다.
업데이트 후 새 대화에서 스킬을 불러오고 `$webapp resume`으로 보존된 작업을 이어갈 수 있습니다.

An enabled plugin and `features.hooks = true` do not prove that its hooks can run.
An enabled hook marked `untrusted` is skipped. This prevents hook-based scheduling
after a real turn ending, not the active-turn execution loop. For that optional
cross-turn recovery, inspect Harness14's four current definitions in `/hooks` and
review and trust them manually. Repeated `$webapp resume` commands do not repair
missing hook trust. Never reset a healthy workflow to address this problem.

For read-only diagnostics, the installed app-server protocol exposes `hooks/list`
with `cwds` set to the project directory. After the normal `initialize`/`initialized`
handshake, inspect `pluginId`, `eventName`, `enabled`, `trustStatus`, `warnings`, and
`errors`. A fresh app-server query reports current configuration; it does not prove
what an already-running IDE process loaded or whether a Stop event was delivered.
Do not invoke trust-changing RPCs or execute hooks as part of this inspection.

The healthy cross-turn fallback is: an evidenced checkpoint, a synchronous Stop hook returning
`decision: "block"` with the continuation marker, and the host submitting that exact
marker as the next prompt. Observe a real subsequent turn before claiming that
automatic continuation works in the current host. If all hooks are trusted and
enabled but no follow-up arrives, investigate hook errors and host delivery rather
than assuming the IDE cannot support hooks.

`resume` also supports a running workflow that already has a pending continuation.
It preserves completed steps and TOPIC, issues a fresh marker, and invalidates old
markers without requiring a preliminary `pause`.

공식 동작과 후크 신뢰 절차: [Codex hooks](https://learn.chatgpt.com/docs/hooks).

## Host compatibility / 호스트 호환성

Claude Code keeps its slash commands; version 2.2 repairs installed hooks and limits automatic approval to eligible project edits and WebSearch. Codex는 자동 승인하지 않으며 기존 영수증·마이그레이션 규칙을 유지합니다.

Automatic continuation after an actual host turn ends requires enabled, trusted Codex hooks; active-turn execution does not.
Skill discovery alone does not prove that the current host delivers continuation events.

패키지 진입점은 [Codex manifest](../.codex-plugin/plugin.json), 신뢰 검토 대상은 [hook definition](hooks/hooks.json), 실행 절차는 [`skills/`](skills/)에서 확인할 수 있습니다.

최종 HTML의 내용 검증, 실제 명령 종료 코드에 근거한 품질 게이트와 Chromium 검사는 [품질 검증 안내](../docs/QUALITY.md)에 설명합니다. 자동 검사와 별개로 실제 사용자에게 유용한 튜토리얼인지 검토해야 합니다.
