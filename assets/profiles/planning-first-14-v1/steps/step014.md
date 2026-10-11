---
name: step014
persistence: session
---

# Step 14 - 콘솔 에러 수집 및 해결


<!-- MOAI-ENRICHED v1 -->

품질 설정 schema2의 frozen 요구 목록에 등록된 모든 검사 ID를 이 단계의 독립 QA에 기존 여섯 회귀 검사와 함께 포함한다. `docs/requirement-coverage.md`의 현재 증거 검사가 누락·미실행·오래된 결과를 거절한다. 최종 `quality-gate.mjs --inspect-final`이 이 공용 검사를 포함하며 완료 표시 전에 통과해야 한다.

> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-014.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 모든 최종 게이트가 PASS일 때만 결과 파일 `step_archive/step014_*.md` 저장 후 1줄 완료 보고 `Step 014/14 완료`.
>
> **모델 정책**: 구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: E2E 검증 구간 (최종 게이트 step014)

브라우저 검증 백엔드(docs/BROWSER-TOOLS.md: Aside CLI 또는 Playwright; 헤드리스 여부는 백엔드에 따름 — Aside는 사용자의 보이는 브라우저·공유 프로필에서 실행되며 보고서 environment.isolation에 기록된다)로 앱의 모든 도달 가능한 상태를 탐색하며 브라우저 에러를 수집하고, 발견된 모든 에러를 해결한다.
에러가 0개가 될 때까지 수정과 재검증을 반복한다.

**이 단계에서 절대로 superpowers:brainstorming을 사용하지 않는다.**

**에러 0개 확인 없이 통과 처리 금지.**

## 핵심 원칙: 작성 에이전트 ≠ 검증 에이전트

- **에이전트 B (검증 전문)**: 브라우저 탐색·에러 수집은 haiku, 에러 분류·PASS/FAIL 판정과 스크린샷 검토는 메인 세션 또는 sonnet 이상(헌법 §7). **수정 금지**
- **에이전트 A (수정 전문)**: Haiku - 에이전트 B의 에러 보고를 받아 수정만 담당. **판정 금지**

이 분리를 통해 검증자의 편견 없는 판정과 수정자의 빠른 피드백 루프를 보장한다.

---

## 수집 대상

브라우저 페이지가 드러내는 **모든 오류 표면**(console.error, window error, unhandledrejection, 요청 실패/차단, 크래시)을 수집한다. 수집 방법은 백엔드별로 docs/BROWSER-TOOLS.md 절차표('Console and page errors' 행)를 따른다 — Aside는 page.on 이벤트가 오지 않으므로 주입 브리지가 `document.documentElement.dataset`에 기록한 값을 evaluate로 읽는다.

잠금 파일이 없거나 유효하지 않으면 필수 환경 입력 누락으로 차단한다. 어떤 이벤트를 수집할지 사전에 결정하지 않는다. 환경 준비 Step 2이 `step_archive/outputs/browser-backend.json`에 고정한 백엔드의 문서(docs/BROWSER-TOOLS.md) 및 프로젝트 특성을 보고 판단한다.

**판정 기준만 명시한다:**
- 에러성 이벤트 → **FAIL 판정 대상**
- 비에러성 이벤트 → 참고 기록만, FAIL 대상 아님

이 분류도 절대적이지 않다. 프로젝트 맥락에 따라 에이전트 B가 판단하되, 에러성 이벤트를 비에러로 분류할 때는 근거를 아래 `분류` 필드에 적는다.

## 수집 범위

앱의 구조, 화면 구성, 네비게이션 방식을 **사전에 가정하지 않는다.**

**동적 탐색 원칙:**

1. 진입점(서빙 URL)에 접속하여 초기 DOM 상태를 분석한다
2. DOM 구조를 읽고, 해당 프로젝트에서 화면 전환을 유발하는 요소가 무엇인지 파악한다
3. 파악된 요소를 순회하며 모든 도달 가능한 화면/상태에 진입한다
4. 각 화면에서 추가 인터랙션 가능한 요소가 있으면 실행하여 숨겨진 상태도 탐색한다
5. 선행 조건(입력, 선택 등)이 필요한 화면이 있으면 해당 흐름을 완료한 뒤 탐색한다

**탐색 완료 조건:** 새로운 화면/상태가 더 이상 발견되지 않을 때까지 반복한다.

각 상태 전환 후 충분히 대기하여 비동기 에러도 수집한다. 대기 시간은 프로젝트 특성에 따라 에이전트 B가 판단한다.

## 검증 절차

### 1단계: 에이전트 B — 에러 수집 및 판정

1. 앱 서빙 방식은 프로젝트에 맞게 결정한다
2. 수집 대상과 수집 범위에 따라 브라우저 자동화 절차를 프로젝트에 맞게 작성한다
3. 모든 도달 가능한 상태를 탐색하며 에러를 수집한다
4. 수집된 에러마다 다음 고정 필드로 보고한다. 필드를 비우지 않는다(해당 없으면 `없음`):
   - 상태: 도달 상태의 key 또는 canonical URL(민감 query 제거)
   - 범주: `console.error` | `window-error` | `unhandledrejection` | `request-failure` | `crash`
   - 메시지: redact한 1줄(토큰·쿠키·자격 증명·민감 query 제거)
   - stack: 첫 애플리케이션 프레임의 `file:line`(번들 줄이면 대응 `src/` 경로를 알 때 함께, 없으면 `없음`)
   - 진입 순서: 진입점에서 그 상태까지 수행한 action 순서
   - 분류: 에러 또는 비에러와 근거 1줄
5. 판정:
   - **PASS**: 에이전트 B가 에러로 분류한 항목이 0개
   - **FAIL**: 1개 이상 → 에러 보고를 에이전트 A에 전달

### 2단계: 에이전트 A — 에러 수정

1. 에이전트 B의 에러 보고를 받는다
2. 각 에러의 원인을 특정한다
3. 원인에 따라 적절한 방식으로 수정한다. 수정 대상과 방법은 에러 유형에 따라 에이전트 A가 판단한다
4. 수정 내역을 에이전트 B에 전달한다

### 3단계: 재검증 (1단계 → 2단계 반복)

에이전트 B가 스크립트를 재실행하여 에러가 해결되었는지 확인한다.

### 반복 제한: 최대 5회

최대 5회까지 수정하고 재검증한다. 실패 항목은 스킵해 통과시키지 않는다.

**탈출 조건:**
1. **PASS** → 콘솔 수정 루프를 끝내고 아래 최종 build·전체 회귀 게이트 수행
2. **동일 에러 3연속 [미수정]** → 차단 원인을 기록하고 중단
3. **5회 후 미해결 FAIL** → 완료로 보고하지 않고 남은 오류를 기록

한도 소진이나 같은 필수 항목의 연속 미수정으로 끝나면 `required-input-missing`, 필수 실행·시각 검사 기능이 없으면 `required-tool-failed`로 헌법 §2-1 명명된 멈춤을 기록하고 턴을 끝낸다.

### 최종 확인

모든 도달 가능한 상태에서 에러 0개 확인 후 아래 최종 build·전체 회귀 게이트 진행

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용한다 (동시 실행 최대 10개).

- **에이전트 B (검증)**: 수집은 haiku, 분류·판정·스크린샷 검토는 메인 세션 또는 sonnet 이상(헌법 §7)
- **에이전트 A (수정)**: haiku 사용 - 수정 담당

## 결과 저장

결과를 step_archive/outputs/step014_콘솔에러.md에 위 고정 필드로 저장한다.

---

**여기가 하네스의 마지막 단계다.** 콘솔 에러 0개 확인 후 프로젝트의 실제 빌드 명령을
1회 실행해 통과를 확인한다. 플러그인 `docs/QUALITY.md`에 따라 다음을 정상 권한으로 실행한다.

```text
node "<plugin-root>/scripts/quality-gate.mjs" --workspace "<project-root>"
node "<validation-checkout>/scripts/verify-output.mjs" --workspace "<project-root>"
```

브라우저 도구는 품질 안내서에 따라 별도 체크아웃에 설치하며 훅이 자동 설치하지 않는다.
`--backend` 없이 실행한 브라우저 검사는 환경 준비 Step 2이 `step_archive/outputs/browser-backend.json`에
고정한 백엔드를 사용한다. 고정 백엔드를 사용할 수 없다는 오류가 나면 그 백엔드만 복구하고
다른 백엔드의 package나 browser binary를 설치하지 않는다. 잠금 파일이 없거나 유효하지 않으면
필수 환경 입력 누락으로 차단하고 Step 2의 환경 준비 증거를 복구한다.
두 명령이 종료 코드 0이고 현재 dist SHA-256과 브라우저 보고서가 일치해야 한다.
브라우저 보고서는 schema version 3이며 HTML의 `harness50-routes` manifest와 모든
경로의 desktop/mobile 측정 결과가 일치해야 한다. 기본 `viewports`와
`compatibility.navigation_api_unavailable.viewports`가 각각 두 viewport와 전체 경로를
포함해야 한다. 호환 시나리오는 앱 시작 전에 Navigation API를 제거하고 실행하며
두 시나리오 모두 하나의 공통 제한 시간 안에서 통과해야 한다. 직접 접속·새로고침·
실제 링크 이동·뒤로/앞으로·unknown fallback의 누락 또는 실패가 있으면 완료하지 않는다.
구형 보고서나 정상 브라우저 결과만으로 새 검증을 대신하지 않는다. 이 동작 보고서만으로
native API 사용을 증명했다고 주장하지 않으며 Step 3 및 Step 9의 실제 분기 검증도 확인한다.
과거 완료 기록의 복구는 새 검증이 아니다. 상세 계약은 `docs/ROUTING.md`를 따른다.
실제 데스크톱·모바일 스크린샷도 메인 세션 또는 sonnet 이상 검증자가 직접 열어 검토한다(헌법 §7). 누락·실패·스킵이 남으면 14/14을 보고하지 않는다.

### 마지막 build 이후 전체 회귀 게이트

최종 build 뒤에는 `docs/QA-REPORTS.md`의 final candidate 절차로 Step14 QA snapshot을
만들고 artifact 목록에 `dist/index.html`을 반드시 넣는다. 이전 9~13단계의 PASS를
그대로 재사용하지 않는다. 보고서에서 전체 검사 목록을 가져오고 새 상태를 포함해,
동일한 최종 HTML에서 다음 여섯 검사를 전부 다시 실행한다.

| 필수 check ID | 전체 재검증 범위 |
|---|---|
| `e2e-regression` | 9단계 성공·실패·전이·edge case 전체 E2E |
| `screenshot-regression` | 10단계 모든 화면·상태·viewport 스크린샷 |
| `keyboard-regression` | 11단계 전체 키보드·포커스 검사 |
| `mouse-regression` | 12단계 전체 마우스·상태 전이 검사 |
| `design-regression` | 13단계 전체 디자인 요구사항·시각 검토 |
| `console-regression` | 14단계 모든 도달 가능 상태의 오류 검사 |

9단계의 local serving URL과 hash/history mode를 유지한다. 검증자는 source와 dist를
수정하지 않는다. 수정·rebuild가 필요하면 새 snapshot과 여섯 검사를 모두 다시 실행한다.
최종 수정·검증 순환은 최대 5회이며 남은 실패·미실행은 `INCOMPLETE`다. 위임하지 못하면
`same-agent`로 기록하고 별도 검증자가 실행했다고 쓰지 않는다.
한도 소진이나 같은 필수 항목의 연속 미수정으로 끝나면 `required-input-missing`, 필수 실행·시각 검사 기능이 없으면 `required-tool-failed`로 헌법 §2-1 명명된 멈춤을 기록하고 턴을 끝낸다.

관측·스크린샷·console 증거 파일을 완성한 뒤 snapshot ID로 모든 결과를 record한다.
기록한 증거는 최종 요약 작성 때 덮어쓰지 않는다. 마지막으로 다음 읽기 전용 검사를
실행하고 종료 코드 0을 확인한다. 실패하면 현재 단계를 완료로 보고하지 않는다.

```text
node "<plugin-root>/scripts/quality-gate.mjs" --inspect-final --workspace "<project-root>"
```

완료 훅도 현재 품질·브라우저·여섯 회귀 검사와 최종 HTML hash를 다시 확인한다.
모든 게이트를 통과한 뒤에만 전체 완료를 보고하며 이후 다른 step 파일을 읽지 않는다.

## 정의별 입력·산출물 계약

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
- 산출물: `step_archive/outputs/step014_콘솔에러.md`
- 산출물: `step_archive/outputs/trust5_r3.md`
- 산출물: `step_archive/outputs/browser-output.json`
- 산출물: `step_archive/screenshots/verified-desktop.png`
- 산출물: `step_archive/screenshots/verified-mobile.png`

필수 수락 항목: `console-error-report`, `final-quality-milestone`, `final-dist-index-html`, `browser-output-report`, `console-errors-zero`, `final-build`, `final-dist-html-boundary`, `reachable-state-manifest`, `warning-classification`, `bounded-settle-no-fixed-sleep`, `secret-redaction`, `independent-console-verifier`, `receipt-first-completion`, `pass-only-final-milestone`, `final-desktop-screenshot`, `final-mobile-screenshot`, `final-visual-inspection`
