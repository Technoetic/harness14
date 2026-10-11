---
name: step014
phase: e2e
---

# Step 14 - 콘솔 에러 수집 및 해결


## 목표

품질 설정 schema2의 frozen 요구 목록에 등록된 모든 검사 ID를 이 단계의 독립 QA snapshot/checks/outcomes에 포함한다. 기존 여섯 회귀 검사와 함께 현재 증거로 검증한다. 누락·미실행·변경된 증거는 `docs/requirement-coverage.md`의 공용 검사와 상태 관리자가 완료를 거절한다.

모든 도달 가능 application 상태에서 browser 오류 표면을 검사하고 0개임을 독립적으로
확인한다. 그 뒤 current build와 최종 dist를 다시 검증하고 세 번째 quality milestone과
내구성 있는 완료 영수증의 순서를 보장한다.

## 입력과 산출물

- 입력: `step_archive/step004_smoke_test.md`
- 입력: `dist/index.html`
- 입력: `step_archive/step008_routing검증.md`
- 입력: `step_archive/outputs/trust5_r2.md`
- 입력: `step_archive/step009_e2e테스트결과.md`
- 입력: `step_archive/step010_screenshot_e2e.md`
- 입력: `step_archive/screenshots/e2e/step010-primary.png`
- 입력: `step_archive/step011_keyboard검증.md`
- 입력: `step_archive/screenshots/keyboard/step011-primary-before.png`
- 입력: `step_archive/screenshots/keyboard/step011-primary-after.png`
- 입력: `step_archive/step012_마우스검증.md`
- 입력: `step_archive/screenshots/mouse/step012-primary-before.png`
- 입력: `step_archive/screenshots/mouse/step012-primary-after.png`
- 입력: `step_archive/outputs/step013_검증_r1.md`
- 입력: `step_archive/screenshots/design/step013-primary-r1.png`
- 입력: `step_archive/step002_환경준비.md`
- 입력: `step_archive/outputs/browser-backend.json`
- 필수 선행 항목: `step002`, `step004`, `step008`, `step009`, `step010`, `step011`, `step012`, `step013`
- 산출물: `step_archive/outputs/step014_콘솔에러.md`
- 산출물: `step_archive/outputs/trust5_r3.md`
- 산출물: `step_archive/outputs/browser-output.json`
- 산출물: `step_archive/screenshots/verified-desktop.png`
- 산출물: `step_archive/screenshots/verified-mobile.png`

- 네트워크: 사용하지 않는다.
- 시각 검토: 필요하다.

## 실행 역할

Required output: `step_archive/outputs/browser-output.json` (`browser-output-report`).
Run the explicit browser verifier after the final build. Completion requires its
passing desktop and mobile results to match the current `dist/index.html` digest.

가능한 경우 콘솔 오류 보정자 역할과 콘솔 오류 독립 검증자 역할을 서로 다른 실행
주체에 맡긴다. 보정자는 재현된 오류 원인만 수정하며, 독립 검증자는 산출물과
application source를 수정하지 않는다. 위임 기능을 사용할 수 없으면 현재 실행자가 두
역할을 명확히 분리해 순서대로 수행하고, 별도 역할을 위임했다고 기록하지 않는다.
정상 권한 확인을 유지하고 자동 승인이나 권한 우회를 금지한다.

## 도달 가능 상태와 오류 수집

application을 분석해 `reachable-state manifest`를 먼저 만든다. manifest에는 `initial`,
`navigation`, `input prerequisite`, `hidden` 상태, 각 진입 action, expected request와
종료 조건을 포함한다. 새 상태가 발견되지 않을 때까지 이미 확인한 stable key와 비교해
탐색하되, 무경계 탐색을 하지 않는다.

각 상태에서 `pageerror`, `unhandled rejection`, `console.error`, `required-request failure`,
browser 또는 application `crash`를 수집한다. 이 다섯 오류 범주는 모든 상태에서 모두
0개여야 한다. warning은 메시지, 상태와 call site 근거로 분류하고 오류를 warning으로
낮춰 기록하지 않는다.

각 오류 finding에는 상태 stable key, 오류 범주, redact한 메시지와 stack의 첫 application
`file:line`을 기록한다. stack이 없으면 없다고 적는다.

각 전이에는 DOM condition, request completion, animation completion 또는 application
ready signal 같은 state-specific `bounded settle condition`을 사용한다. fixed sleep은
사용하지 않는다. credential, token, cookie, authorization header와 sensitive query
data는 저장 전에 redact하고 원문 비밀을 보고서에 남기지 않는다.

최대 5라운드 동안 독립 검증자가 전체 manifest를 실행해 오류를 판정하고, 보정자가
원인을 최소 변경한 뒤 전체 manifest를 다시 실행한다. `Critical` 또는 `Important`
finding이 하나라도 미해결이면 차단한다. 필수 입력, 필수 증거 또는 실행 capability가
없거나 사용할 수 없으면 차단한다. 모든 상태와 오류 범주가 증거와 함께 `PASS`인
경우에만 console 검증을 통과한다. 스킵이나 미해결 finding은 통과 또는 완료 증거가
아니다.

## 최종 build와 완료 순서

플러그인의 `docs/QUALITY.md`에 따라 실제 품질 검사와 브라우저 검사를 실행한다.
브라우저 의존성은 안내서대로 별도 검증 체크아웃에 준비하며 훅에서 설치하지 않는다.
`--backend` 없이 실행한 브라우저 검사는 환경 준비 2단계가 `step_archive/outputs/browser-backend.json`에
고정한 backend를 사용한다. 고정 backend를 사용할 수 없다는 오류가 나면 그 backend만 복구하고
다른 backend의 package나 browser binary를 설치하지 않는다. 잠금 파일이 없거나 유효하지 않으면 필수 환경 입력 누락으로 차단한다.

```text
node "<plugin-root>/scripts/quality-gate.mjs" --workspace "<project-root>"
node "<validation-checkout>/scripts/verify-output.mjs" --workspace "<project-root>"
```

아래 최종 build가 끝난 뒤 위 두 명령을 실행한다. 두 종료 코드가 0이고 보고서가 현재
dist를 가리켜야 한다. `browser-output-report` 증거를 제출하면 상태 관리자가 두 화면의
측정 결과와 현재 HTML SHA-256을 검증한다. 실패·누락·오래된 보고서는 완료할 수 없다.

보고서는 schema version 3이어야 하며 HTML의 `harness50-routes` manifest와 모든
경로의 desktop/mobile 측정값이 정확히 대응해야 한다. 기본 `viewports`와
`compatibility.navigation_api_unavailable.viewports`가 각각 두 viewport와 모든 경로를
포함해야 한다. 호환 시나리오는 앱 시작 전에 Navigation API를 제거하고 실행하며
두 시나리오 모두 하나의 공통 제한 시간 안에서 통과해야 한다. 직접 접속·새로고침·실제
링크·뒤로/앞으로·unknown fallback의 누락 또는 실패는 완료를 차단한다. 구형 보고서나
정상 브라우저 결과만으로 대신하지 않는다. 동작 보고서만으로 native API 사용을 단정하지
말고 Step 3 및 Step 9의 실제 분기 검증도 확인한다. `docs/ROUTING.md`를 기준으로 확인하며
과거 완료 영수증의 복구는 새로운 경로 검증을 뜻하지 않는다.

console 검증이 `PASS`인 뒤 project manifest에 선언된 정확한 build 명령을 정상 권한
흐름으로 실행하고 exit code 0만 성공으로 인정한다. build가 만든 `dist/index.html`은
symbolic link가 아닌 일반 파일이고 0바이트보다 크며, UTF-8 content에 `<html` opening과
`</html>` closing boundary가 있어야 한다. before/after metadata와 digest로 current
artifact임을 확인한다.

### 동일한 최종 후보의 전체 회귀 검증

마지막 수정과 build 뒤 `docs/QA-REPORTS.md`의 final candidate 절차로 Step14 QA
snapshot을 만든다. artifact 목록에는 `dist/index.html`을 반드시 넣는다. 9단계의
local serving URL과 hash/history mode를 유지하고, 다음 여섯 필수 check ID를 선언한다.

| check ID | 최종 후보에서 다시 실행할 전체 범위 |
|---|---|
| `e2e-regression` | 9단계의 성공·실패·전이·edge case 전체 시나리오 |
| `screenshot-regression` | 10단계의 모든 화면·상태·viewport 스크린샷 검토 |
| `keyboard-regression` | 11단계의 전체 키보드 입력·포커스·상태 전이 |
| `mouse-regression` | 12단계의 전체 마우스 입력·상태 전이 |
| `design-regression` | 13단계의 전체 디자인 요구사항과 독립 시각 검토 |
| `console-regression` | 이 단계의 reachable-state manifest와 다섯 오류 범주 |

기존 보고서에서 전체 검사 목록을 가져오되 새로 생긴 상태도 포함한다. 이전 PASS를
복사하거나 첫 화면 검사만으로 대체하지 않는다. 검증 동안 source와 dist를 수정하지
않는다. 수정 또는 rebuild가 필요하면 새 최종 후보를 만든 뒤 새 snapshot과 여섯
검사를 모두 다시 실행한다. 이 최종 수정·검증 순환은 최대 5회이며 미해결·미실행은
`INCOMPLETE`로 남긴다. 별도 검증자가 없으면 `same-agent`로 정확히 기록한다.

새 관측·스크린샷·console 증거 파일을 모두 완성한 뒤 같은 snapshot ID로 여섯 결과를
record한다. 기록에 사용한 증거 파일은 최종 요약 작성 때 다시 덮어쓰지 않는다.
과거 9~13 영수증은 수정하지 않는다. 상태 관리자는 현재 Step14 QA 보고서의 여섯
PASS와 최종 HTML hash를 직접 확인하며, 품질 보고서도 현재 source·설정·coverage와
대조한다. 누락·실패·오래된 결과는 새 완료 영수증을 만들 수 없다.

독립 검증자는 console, exact build, final dist와 보고서 evidence를 다시 확인한다. 모든
필수 gate가 `PASS`인 뒤에만 `step_archive/outputs/step014_콘솔에러.md`와
`step_archive/outputs/trust5_r3.md`를 최종 수락 증거로 제출한다.

현재 skill은 현재 attempt evidence만 제출한다. 상태 관리자가 evidence를 검증한 뒤
14단계 영수증을 내구성 있게 먼저 기록한다. 영수증이 기록된 뒤에만 `completed`,
`current_step:null`, `completed_at`을 반영한다. 그 사이 crash가 나면 상태 관리자는
영수증에서 앞으로 reconcile한다. 영수증 기록이나 complete operation이 실패하면
14/14을 보고하지 않는다.

영수증은 단계 artifact가 아니며 이 문서나 실행 역할은 직접 상태나 영수증을 쓰지
않는다. `Stop`은 유효한 영수증과 completed 상태를 모두 확인한 뒤에만 종료를 허용한다.
완료 뒤 continuation을 발행하지 않고 미래 단계 파일을 읽지 않는다.

## 완료 조건

- `console-error-report`: state manifest, redacted finding과 판정이 기록됐다.
- `final-quality-milestone`: 모든 gate 뒤 세 번째 milestone이 기록됐다.
- `final-dist-index-html`: final build가 만든 dist HTML이 존재한다.
- `console-errors-zero`: 다섯 오류 범주가 모든 상태에서 0개다.
- `final-build`: manifest의 exact non-optional build가 성공했다.
- `final-dist-html-boundary`: final dist가 regular·nonempty·HTML boundary 조건을 충족한다.
- `reachable-state-manifest`: initial, navigation, prerequisite와 hidden 상태를 탐색했다.
- `warning-classification`: 모든 warning을 근거와 함께 분류했다.
- `bounded-settle-no-fixed-sleep`: bounded condition만 사용했고 fixed sleep이 없다.
- `secret-redaction`: 저장된 증거에 credential이나 token이 없다.
- `independent-console-verifier`: 비수정 독립 검증자가 전체 gate를 확인했다.
- `receipt-first-completion`: durable receipt가 completed 상태와 14/14 보고보다 먼저다.
- `pass-only-final-milestone`: 모든 필수 gate가 `PASS`다.
- `measured-quality-report`: 상태 관리자가 현재 품질 PASS를 검사하고 보고서 hash를 기록했다.
- `final-regression-report`: 상태 관리자가 여섯 전체 회귀 검사와 최종 HTML 결속을 검사하고 불변 QA 보고서 hash를 기록했다.
- `final-desktop-screenshot`: 최종 브라우저 검사의 desktop 화면 증거가 존재한다.
- `final-mobile-screenshot`: 최종 브라우저 검사의 mobile 화면 증거가 존재한다.
- `final-visual-inspection`: 최종 화면과 전체 screenshot·design 회귀 검사를 실제로 열어 시각 검토했다.

보고서와 milestone을 수락 증거로 제출하고 현재 단계에서 멈춘다.
