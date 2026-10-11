---
name: step003
persistence: session
---

# Step 3 - 구현

<!-- MOAI-ENRICHED v1 -->

사용 가능한 코드 진단 도구의 실제 출력을 플러그인 `docs/diagnostic-delta.md`에 따라 정규화하여 수정 전 baseline을 capture하고 수정 뒤 compare한다. 새 오류·해결·유지 항목을 수정 우선순위에만 활용한다. 비교는 도구 실행·자동 되돌리기·품질 PASS를 대신하지 않는다.

> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-003.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step003_*.md` 저장 후 1줄 완료 보고 `Step 003/14 완료`.
>
> **모델 정책**: 구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: 구현·정리 구간 (E2E 검증 step009 전)

**참조 파일:**

- `step_archive/TOPIC/TOPIC.md` (튜토리얼 주제 — **필수. 구현 서브에이전트 모두에게 본 파일 경로를 프롬프트로 전달한다**)
- `step_archive/step002_환경준비.md`와 현재 브라우저 백엔드 잠금

## 구현 전 작업 소유권과 인코딩

어떤 구현 파일도 수정하기 전에 `step_archive/step003_구현manifest.md`의 첫 절에
작업 단위 ID / 담당자 / 담당 파일(1~3개) / 의존 작업 ID / 실행 순서를 기록한다.
파일 소유권은 겹치지 않아야 하며 충돌하면 작업을 멈추고 먼저 해소한다. 각 작업자는
자기 파일만 수정하고 독립 검증자는 소유권 표·전후 digest·실제 RED/GREEN 증거를 확인한다.
필요한 컨텍스트는 명시 경로와 500줄 이하 청크로 읽으며 삭제한 정책 문서를 요구하지 않는다.

소스와 보고서는 UTF-8 무BOM·LF로 작성한다. PowerShell 5.1에서는
`[System.IO.File]::WriteAllText(path, text.Replace("`r`n", "`n"), [System.Text.UTF8Encoding]::new($false))`
처럼 인코딩과 개행을 명시한다. `Set-Content -Encoding UTF8`은 이 호스트에서 BOM/CRLF를
쓰기 때문에 이 규칙을 충족하지 않는다. 생성한 바이트는 빌드4에서 다시 검사한다.

## 실행 내용

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용하여 (동시 실행 최대 10개) step002_레이아웃설계_chunk*.md (레이아웃 설계)와 step002_전체설계_chunk*.md (전체 설계)를 구현한다.

**모든 구현 서브에이전트 프롬프트의 첫 문단에 다음을 포함한다:**

> "먼저 `step_archive/TOPIC/TOPIC.md`를 Read하여 튜토리얼 주제·타깃·인터랙티브 요구·대중 앱 사례를 파악한다. 본 주제와 무관한 콘텐츠를 생성하지 마라. `audience`가 초보자이면 전문 용어 즉시 풀어 설명하고, `interactive`가 필수이면 모든 핵심 개념마다 사용자가 직접 조작 가능한 위젯(슬라이더·입력·실행 버튼)을 1개 이상 배치한다. `real_world_apps`의 사례는 본문 예시에 1개 이상 반영한다."

Class 지향으로 구현한다.

## 필수: 선택 설계와 현재 구현 화면 대조

CSS 담당자는 `step_archive/step002_레이아웃설계_chunk1.md`의 `harness50-design-contract`를
읽고 CSS 값을 `tokens`에 연결한다. `exclude`의 `adopted: false` 항목은 구현하지 않는다.
현재 application을 렌더링해 `step_archive/screenshots/implementation/step003-current.png`에 저장하고
실제로 열어 선택 설계와 대조한다. selector·관찰 영역·토큰·접근성 판정을 구현 manifest에 기록한다.
시각 검사 기능이 없으면 INCOMPLETE다. 구현자는 설계 대안을 다시 선택하지 않는다.
CSS 시각 담당자는 sonnet 이상, 그 외 JS·HTML 담당자는 haiku를 사용한다.
구현 단계에서 superpowers:brainstorming을 사용하지 않는다.

## 구현 완료 후 자동 검증

플러그인 `docs/ROUTING.md`와 2단계 화면별 URL 표를 구현한다. `dist/index.html`의
실제 `<head>` 안에 `harness50-routes` JSON script를 하나 넣고 각 독립 화면 루트에
`data-harness-screen` ID를 부여한다. manifest의 모든 화면을 구현하며 현재 URL과
일치하는 화면만 보이게 한다. 여러 화면이면 각 화면에서 다른 선언 화면으로 가는
실제 `a[href]` 링크를 제공한다. 주소 변경 없이 화면만 바꾸는 메뉴는 허용하지 않는다.
직접 접속·새로고침·뒤로/앞으로·잘못된 주소 fallback을 실패 테스트부터 구현한다.
제목·활성 메뉴·포커스도 갱신한다. 참고 구현은 `examples/routed-single-file.html`이다.

HTTP(S)에서 `navigation.currentEntry`와 실제 `intercept` capability가 사용 가능하면
Navigation API를 우선 사용하고, 미지원 환경에는 선언한 hash/history URL 형식에 맞는
기존 History API/hash backend를 제공한다. 파일 직접 열기를 지원하려면 hash manifest를
선택한다. history manifest는 HTTP(S)가 필요하며 실행 환경에 따라 mode를 암묵 변환하지 않는다.
backend는 하나만 활성화해 동일 전이를 중복 처리하지 않는다. 첫 문서의 URL 복원은 명시적으로
실행하며, 앱의 `#/...` 변경과 unknown fallback도 처리한다. 실제 `a[href]`를 유지하고
수정키·다른 target·download·외부 링크·form·일반 `#section` 앵커의 기본 동작은 보존한다.
개별 navigate 이벤트도 `canIntercept`를 확인해 가로챌 수 없는 이동은 우회한다.

실제 지원 브라우저의 native Navigation API 분기와 앱 시작 전에 API를 제거한 강제
호환 분기를 각각 실패→통과 테스트한다. hash/history URL 형식과 backend 선택을 구분해
증거를 남긴다. 가짜 API만 주입한 테스트는 실제 native 분기의 통과 증거가 아니다.
일반 URL/화면 동작만으로 사용한 API를 단정하지 말고 실제 capability와 선택 분기의
프로젝트별 관측 증거를 함께 기록한다. 초기 진입·reload·Back/Forward·앱 hash 변경·
unknown fallback 및 가로채면 안 되는 링크와 form도 두 분기에서 검증한다.

구현이 완료되면 다음 Step(step004 빌드 스모크 테스트)에서 빌드 안전성을 자동 검증한다.
Step 4에서 빌드 실패 시 이 Step으로 돌아와 수정한다.

## Budget Forcing

서브에이전트가 구현을 너무 빨리 완료하려 할 때 다음을 강제한다:
- 구현 완료 선언 전에 "빠뜨린 엣지 케이스가 없는가?" 를 반드시 검토한다
- 검토 없이 완료 선언 시 해당 서브에이전트는 재실행한다

## Jev 의미 체크포인트

`step_archive/step003_구현manifest.md`의 증거 섹션에 실제 구현에서 선택한 본문 발췌문을 출처 파일·위치·hash와 함께 먼저 저장한다. 대상 독자·핵심 용어와 이 저장된 설명을 함께 선택한다. 구현이 바뀌면 호스트가 출처를 다시 대조해 증거를 갱신한다. Jev는 저장된 텍스트만 평가하며 코드 실행 정확성을 증명하지 않는다.

현재 작업에서 Jev 사용과 선택한 발췌문의 외부 전송이 승인된 경우 호스트가 자동 호출한다.
기존 승인이 해당 범위를 포함하면 재확인하지 않는다. 단계 도달이나 `TYPESAFE_API_KEY` 존재는 승인이 아니다.
승인이 없거나 서비스가 불가하면 이유를 기존 단계 보고서에 기록하고 독립 검증을 계속한다.

신뢰한 플러그인의 `node "<plugin-root>/scripts/jev-judge.mjs" prepare --workspace ROOT --input -`로 준비한다.
재사용 전 `inspect --workspace ROOT --report PATH`의 상태와 현재 prepare의 `request_hash`, `policy_hash`, `input_hash`, `sources`를 모두 대조한다.
새 호출은 동일 JSON으로 `run --workspace ROOT --input - --allow-network`를 실행한다.
변하지 않은 입력에는 한 배치만 호출하는 호스트 정책을 적용하며 전역 하드 쿼터로 해석하지 않는다.
`unverified`·`stale`는 판정 근거로 쓰지 않고 abstain·낮은 confidence는 호스트가 원본을 검토한다.
승인된 선택 API 예외는 일반 웹 탐색이나 새 자료 수집을 허용하지 않는다.

입력 파일·발췌문 범위, 동의·중복 방지·보고서 검사는 `docs/jev-checkpoints.md`를 따른다.
기존 독립 검증·Acceptance·실제 검사와 완료 writer는 유지한다. Jev 결과나 `current`는 PASS 또는 완료 권한이 아니다.

## Self-Calibration

구현 완료 후 다음을 스스로 평가하라:
- 요구사항이 100% 구현되었는가? (Y/N)
- 빌드가 통과하는가? (Y/N)
- N이면 해당 부분을 보완하고 재평가한다. 3회 재시도 후에도 해결되지 않으면 오류·미해결 항목·다음 검사를 현재 Step 결과 파일에 기록하고 현재 Step을 INCOMPLETE로 인계한다. 완료 보고와 다음 Step 진입은 금지하고 헌법 §2-1 명명된 멈춤으로 끝낸다(필수 도구 실패 `required-tool-failed`, 권한 거부 `permission-denied`, 그 밖의 한도 소진 `required-input-missing`). 선택 도구를 쓸 수 없는 것은 미달이 아니다 — `SKIP`과 사유를 기록한다.

---

이 지침을 완료한 즉시 자동으로 step004.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.

## 정의별 입력·산출물 계약

- 입력: `step_archive/TOPIC/TOPIC.md`
- 입력: `step_archive/outputs/step002_설계선택.md`
- 입력: `step_archive/step002_레이아웃설계_chunk1.md`
- 입력: `step_archive/step002_전체설계_chunk1.md`
- 입력: `step_archive/step002_환경준비.md`
- 입력: `step_archive/outputs/browser-backend.json`
- 산출물: `step_archive/step003_구현manifest.md`
- 산출물: `step_archive/screenshots/implementation/step003-current.png`

필수 수락 항목: `implementation-manifest`, `implementation-current-screenshot`, `topic-field-fidelity`, `selected-design-only`, `class-async-accessibility`, `incremental-test-evidence`, `visual-evidence-inspection`, `independent-implementation-verifier`, `implementation-ownership-and-encoding`
