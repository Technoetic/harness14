---
name: step003
phase: implementation
---

# Step 3 - 구현

## 목표

플러그인 `docs/diagnostic-delta.md`를 따라 사용 가능한 코드 진단 도구의 실제 출력을 정규화하고 수정 전 baseline을 capture한다. 수정 뒤 같은 도구·설정·선택 파일 범위의 compare 결과에서 새 오류를 우선 확인한다. 도구 실행은 호스트가 수행하며 비교 결과가 품질 PASS나 자동 되돌리기를 허가하지 않는다.

불변 주제 계약과 독립 선택된 통합 설계 하나를 실제 application으로 구현한다. 설계
대안을 다시 열지 않고, 파일 소유권과 incremental test 증거로 구현 범위를 추적한다.

## 입력과 산출물

- 입력: `step_archive/TOPIC/TOPIC.md`
- 입력: `step_archive/outputs/step002_설계선택.md`
- 입력: `step_archive/step002_레이아웃설계_chunk1.md`
- 입력: `step_archive/step002_전체설계_chunk1.md`
- 입력: `step_archive/step002_환경준비.md`
- 입력: `step_archive/outputs/browser-backend.json`
- 필수 선행 항목: `step002`
- 산출물: `step_archive/step003_구현manifest.md`
- 산출물: `step_archive/screenshots/implementation/step003-current.png`

- 네트워크: 승인된 Jev 선택 API만 허용한다. 일반 웹 탐색과 새 자료 수집은 사용하지 않는다.
- 시각 검토: 필수

## 실행 역할

가능한 경우 파일 소유권이 겹치지 않는 모듈 구현자 역할과 구현 독립 검증자 역할을
서로 나눈다. 각 구현자는 선언된 module만 바꾸며, 독립 검증자는 작성 산출물을 수정하지
않는다. 위임 기능을 사용할 수 없으면 현재 실행자가 두 역할을 명확히 분리해 순서대로
수행하고, 별도 역할을 위임했다고 기록하지 않는다. 정상 권한 확인을 유지하고 자동
승인이나 권한 우회를 금지한다.

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

## 선택 설계 구현

가장 먼저 `step_archive/TOPIC/TOPIC.md`를 확인하고 수정하지 않는다. `topic`,
`audience`, `interactive`, `real_world_apps`, `constraints`의 값을 요구 추적표에 고정한다.
초보 audience에는 용어를 즉시 설명하고, interactive가 필수이면 핵심 개념마다 직접
조작 가능한 control을 제공하며, `real_world_apps`에서 최소 한 사례를 본문에 반영한다.
모든 constraints는 구현 파일과 test에 연결한다.

`step002_설계선택.md`가 가리키는 선택된 2단계 설계만 구현하고 대안을 다시 선택하지 않는다.
구현 manifest 첫 절의 파일/모듈 소유권을 지켜 각 work unit이
1~3개 파일만 수정하게 한다. 의존성 순서대로 unit을 실행하며 겹치는 파일이 발견되면
작업을 멈추고 소유권부터 해소한다.

각 기능은 실패하는 테스트를 먼저 실행해 요구가 아직 충족되지 않음을 확인하고, 최소
구현으로 통과시킨 뒤 중복만 리팩터링한다. Class 책임과 constructor dependency,
public/private boundary, async initialization·start·cancellation·error lifecycle, responsive
interaction과 키보드·focus·motion·touch·contrast 접근성을 설계 그대로 구현한다.

현재 application을 렌더링해 `step_archive/screenshots/implementation/step003-current.png`에
저장한다. 시각 검사 기능으로 실제로 열어 선택 설계와 대조한다.
CSS 결정마다 관찰한 화면 영역, 색·간격·type·motion 근거와 구현 selector를 연결한다.
시각 검사 기능을 사용할 수 없으면 이 단계를 차단한다.
CSS 값은 2단계 레이아웃 설계의 `harness50-design-contract` `tokens`로만 정한다. `exclude`에서
`adopted`가 false인 항목은 제공 예시에 보이더라도 구현하지 않는다(목록 우선). 계약 블록이 없으면
플러그인 `docs/DESIGN-CONTRACT.md`의 계약 없는 작업 공간 절차를 따른다.

`step_archive/step003_구현manifest.md`에는 work unit, 담당 파일, 변경 전후 digest,
요구 추적 ID, test의 RED·GREEN 결과, Class·async 계약, 시각 근거의 화면 영역과 CSS
selector, 미해결 항목을 기록한다. TOPIC과 선택 문서의 digest도 포함한다.

## 독립 검증

화면 주소 구현도 검증한다. 플러그인 `docs/ROUTING.md`와 2단계 주소 표를 기준으로
단일 `dist/index.html`의 실제 `<head>` 안에 `harness50-routes` JSON script 하나를
포함한다. 각 화면 루트의 `data-harness-screen` ID와 manifest를 일대일 대응시키고
현재 URL의 화면만 표시한다. 여러 화면이면 각 화면에 다른 선언 화면으로 가는 실제
`a[href]` 링크가 있어야 한다. URL 변경 없는 메뉴 전이는 허용하지 않는다.
직접 접속·새로고침·뒤로/앞으로·unknown fallback의 실패→통과 증거와 제목·활성 메뉴·
포커스 갱신을 구현 manifest에 연결한다. 참고 구현은 `examples/routed-single-file.html`이다.

HTTP(S)에서 `navigation.currentEntry`와 실제 `intercept` capability가 사용 가능하면
Navigation API를 우선 선택한다. 미지원 환경은 선언한 hash/history URL 모드에 맞는
기존 History API/hash backend를 사용한다. 파일 직접 열기를 지원하려면 hash manifest를
선택한다. history manifest는 HTTP(S)가 필요하며 실행 환경에 따라 mode를 암묵 변환하지 않는다.
backend 하나만 활성화하며 첫 문서의 URL 복원을 이벤트에 맡기지 않고 명시적으로 실행한다. 앱의 모든
`#/...` 변경과 unknown fallback을 처리하고 실제 링크의 수정키·다른 target·download·
외부 이동, form과 일반 `#section` 앵커는 가로채지 않는다.
개별 navigate 이벤트의 `canIntercept`를 확인해 가로챌 수 없는 이동은 우회한다.

실제 지원 브라우저의 native Navigation API 분기와 앱 시작 전 API를 제거한 강제 호환
분기를 각각 실패→통과 테스트한다. 초기 진입·reload·Back/Forward·앱 hash 변경·unknown
fallback 및 링크/form 우회를 포함한다. 가짜 API만 주입한 테스트는 native 분기의 증거가
아니다. URL/화면 동작만으로 사용 API를 단정하지 말고 실제 capability와 backend 선택의
프로젝트별 관측 증거를 구현 manifest에 연결한다.

구현 독립 검증자는 TOPIC 다섯 필드, 선택된 설계 하나, 파일 소유권, 실제 test 결과,
Class·async·접근성 계약과 screenshot-to-CSS 추적을 처음부터 확인한다. 구현이나 manifest를
직접 고치지 않고 evidence가 빠진 항목을 `PASS`로 바꾸지 않는다.

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

## 완료 조건

- `implementation-ownership-and-encoding`: Declares non-overlapping one-to-three-file work units and dependencies before edits, and writes UTF-8 without BOM using LF.

- `implementation-manifest`: 구현 파일·digest·소유권·test·요구 추적이 기록됐다.
- `implementation-current-screenshot`: 현재 구현 screenshot이 존재하고 실제로 열었다.
- `topic-field-fidelity`: TOPIC 다섯 필드를 변경 없이 구현에 반영했다.
- `selected-design-only`: 선택된 통합 설계 하나만 구현했다.
- `class-async-accessibility`: Class·async·interaction·accessibility 계약을 구현했다.
- `incremental-test-evidence`: 각 module의 실패·최소 구현·통과 cycle이 기록됐다.
- `visual-evidence-inspection`: screenshot을 실제로 열고 CSS 근거를 추적했다.
- `independent-implementation-verifier`: 비수정 독립 검증이 모든 증거를 확인했다.

manifest와 검증 결과를 수락 증거로 제출하고 현재 단계에서 멈춘다. workflow 상태와
영수증만이 이후 진행을 소유한다.
