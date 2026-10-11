---
name: step002
persistence: session
---

# Step 2 - 통합 설계와 환경 준비 (레이아웃 + 전체)

<!-- MOAI-ENRICHED v1 -->

설계를 확정한 뒤 구현 전에 플러그인 `docs/requirement-coverage.md`에 따라 검토한 요구 목록과 검증 기준·검사 ID 연결을 freeze한다. 반환된 SHA256을 `harness50.quality.json` schema2의 `requirements.inventory_sha256`에 등록한다. 모든 등록 검사를 최종 독립 QA에 포함한다. 이 절차는 아래 첫 설계 도구 호출 규칙을 앞당기거나 대체하지 않는다.

> **📐 Plan → Run → Sync** (MoAI-ADK 워크플로우)
> - **Plan**: 본 Step의 SPEC 자동 생성 `step_archive/specs/SPEC-002.md` 를 먼저 읽고 Acceptance 기준을 확정한다.
> - **Run**: 본문 지침대로 실행. 구현 산출물에는 `@MX:NOTE` 최소 1개 부착 (위험 시 `@MX:WARN` + `@MX:REASON`, 계약 시 `@MX:ANCHOR` + `@MX:REASON`, 미완료 시 `@MX:TODO`). MoAI mx-tag-protocol SoT 준수.
> - **Sync**: 결과 파일 `step_archive/step002_*.md` 저장 후 1줄 완료 보고 `Step 002/14 완료`.
>
> **모델 정책**: 구현 서브에이전트 = **haiku** (CLAUDE.md 정책 준수). 평가 라운드만 sonnet.
>
> **위치**: 구현·정리 구간 (E2E 검증 step009 전)

## 🚨 절대 규칙 (Hook이 자동 차단)

이 Step의 **첫 번째 도구 호출은 반드시**:

```
Skill(skill="superpowers:brainstorming")
```

이 호출 전에는 Write/Edit/Bash/Task 등 어떤 도구도 사용 금지.
(이 규칙은 CLAUDE.md "step002 brainstorming 처리" 절대 규칙으로 강제된다 —
구버전이 주장하던 brainstorming-gate.ps1 자동 차단은 해당 훅이 retired/미바인딩이라
실재하지 않았음. 2026-06-10 하네스 감사 M07 정정.)

## Step-Back

설계 전에 먼저 답하라:
- 이 설계가 해결해야 할 핵심 문제는? (한 문장)
- 요구사항/기획 결과에서 반드시 반영해야 할 제약 조건은?

## 실행 내용

step001 기획 결과를 기반으로 레이아웃 설계와 전체 설계를 superpowers:brainstorming에 진입하여 레이아웃을 포함한 전체 설계 문서를 작성한다.

**설계 시작 전 반드시 `step_archive/TOPIC/TOPIC.md`를 Read한다.** 인터랙티브 요구(`interactive`), 타깃(`audience`), 대중 앱 사례(`real_world_apps`)가 레이아웃·인터랙션 설계에 반영되어야 한다. 단, brainstorming 스킬의 사용자 옵션 질문은 헌법 §4에 따라 금지하고, 결정을 즉시 내려 설계 문서에 사유와 함께 기록한다.

**필요한 파일:**

- `step_archive/TOPIC/TOPIC.md` (필수, 가장 먼저 Read)

- step001_planning_chunk*.md (요구 추적과 독립 PASS를 기록한 기획)
- `step_archive/outputs/step001_검증_r*.md` (최종 독립 PASS와 기획 청크 해시)

설계 전에 최종 독립 PASS 및 기획 청크별 SHA-256 일치를 확인한다. 현재 기획의 독립 PASS와 실제 청크 해시를 대조한다.
최종 보고서 누락·FAIL·해시 불일치이면 설계를 시작하거나 Step 2을 완료하지 않고 미완료로 인계한다.

**설계 범위:**

- 레이아웃 구조, 배치, 비율, 반응형 브레이크포인트
- 전체 아키텍처, 클래스 구조, 모듈 설계
- 위 항목을 하나의 설계 문서로 통합

**Class 지향으로 설계한다.** 그리고 **비동기(async)로 설계한다.**

### Class 지향 설계 원칙

- 모든 주요 기능 모듈은 **ES6+ Class**로 정의한다 (예: `LayoutManager`, `AnimationController`, `DataLoader`).
- Class는 **단일 책임 원칙(SRP)**을 따른다 — 한 Class는 하나의 명확한 책임만 가진다.
- **상속(extends)보다 합성(composition)을 우선**한다. 공통 동작은 Mixin 또는 베이스 Class로 분리한다.
- 외부 노출 API는 **public 메서드**로 명시하고, 내부 구현은 `#privateField` 또는 `_privateMethod` 컨벤션으로 캡슐화한다.
- 전역 변수·전역 함수 금지. 모든 상태는 **Class 인스턴스의 필드**로 관리한다.
- 의존성은 **생성자 주입(Constructor Injection)** 방식으로 받는다. `new Foo(dep1, dep2)` — 내부에서 `new` 직접 호출 금지.
- Class 간 통신은 **EventTarget / CustomEvent** 또는 **명시적 메서드 호출**로 한다. 암묵적 전역 상태 공유 금지.

### 비동기 설계 원칙

- 모든 I/O·네트워크·DOM 로딩·애니메이션·타이머 작업은 **async/await + Promise**로 처리한다.
- Class의 초기화는 **`async init()` 패턴**을 사용한다 — 생성자는 동기로 가볍게 유지하고, 무거운 초기화는 `await instance.init()`로 분리.
- 콜백 헬(callback hell) 금지. **Promise 체인**도 가급적 피하고 **async/await**로 통일한다.
- 병렬 처리가 가능한 작업은 **`Promise.all([...])`** 또는 **`Promise.allSettled([...])`**로 동시 실행한다.
- 에러 처리는 **try/catch**로 명시적으로 한다. unhandled rejection 금지.
- 취소 가능한 비동기 작업은 **AbortController/AbortSignal**을 지원한다.
- 무거운 동기 연산은 **`requestIdleCallback`** 또는 **Web Worker**로 오프로드한다.
- 이벤트 리스너도 가능한 한 **passive: true** 옵션과 **debounce/throttle**를 적용한다.

### 설계 문서에 반드시 포함할 내용

- 각 Class의 **클래스 다이어그램** (Mermaid 또는 ASCII 아트)
- 각 Class의 **public API 시그니처** (async 여부 명시: `async loadData(): Promise<Data>`)
- Class 간 **의존 관계도**
- 주요 **비동기 흐름의 시퀀스 다이어그램**
- 초기화 순서: `new` → `await init()` → `await start()` 등의 라이프사이클 명시

## 설계 대안 비교 (ToT)

### 화면별 URL 설계 계약

플러그인의 `docs/ROUTING.md`를 읽고 전체 설계에 **화면 ID / 목적 / canonical path /
진입 링크 / 새로고침 후 기대 화면** 표를 필수로 넣는다. 기획의 모든 독립 화면과
일대일 대응해야 한다. 단일 HTML은 유지하고 기본은 `index.html#/orders` 같은 hash
라우팅이다. history 모드는 `/orders` 또는 `/orders.html`을 같은 HTML로 연결하는
배포 설정과 실제 배포 URL 검증 방법을 설계한 경우에만 선택한다.

정적 manifest의 schema version 1을 유지한다. `mode`는 URL 형식이며 backend 선택과 별개다. HTTP(S)에서
`navigation.currentEntry`가 null이 아니고 실제 `intercept` capability가 있을 때
Navigation API를 우선 선택한다. API 이름의 존재만으로 사용 가능하다고 판단하지 않는다.
미지원 환경은 선언한 모드에 맞는 기존 History API 또는 hash로 처리한다. 파일 직접
열기를 지원하려면 hash manifest를 선택한다. history manifest는 HTTP(S)가 필요하며
실행 환경에 따라 mode를 암묵 변환하지 않는다. 활성 backend는 하나만 설치하고 첫 문서
로드는 이벤트를 기다리지 않고 현재 URL로 명시적으로 초기화한다. 앱 hash 경로의 모든 변경과 unknown fallback을
복원한다. 수정키 클릭·다른 target·download·외부 링크·form·일반 문서 앵커는 가로채지
않도록 경계를 설계한다. 일반 `#section`과 앱 경로 `#/orders`를 구별한다.

`harness50-routes` JSON manifest, `[data-harness-screen]` 화면 루트, URL→화면 복원,
실제 `a[href]` 이동, 뒤로·앞으로 가기, 알 수 없는 주소의 fallback을 함께 설계한다.
제목·활성 메뉴·포커스도 전이에 맞게 갱신한다. 모드 선택 이유를 기록하고 URL 없이
화면만 바꾸는 설계는 통과시키지 않는다. 세 대안 모두 이 계약을 만족해야 한다.
실제 Navigation API 분기와 앱 시작 전 API를 제거한 호환 분기를 검증할 방법도 기록한다.

단일 설계안을 바로 확정하지 않는다. 다음 순서로 진행한다.

### 1단계: 설계 대안 3개 생성 (에이전트 A)

에이전트 A가 기획 결과를 기반으로 **레이아웃 설계안 A/B/C**를 생성한다.
- 각 안은 레이아웃 구조, 모듈 분리 방식, 반응형 전략이 서로 달라야 한다.
- 결과: `step_archive/outputs/step002_설계대안.md`

### 2단계: 트레이드오프 비교 및 선택 (에이전트 B)

에이전트 B가 3개 안을 다음 기준으로 비교하고 **1개를 선택**한다. (수정 금지, 선택만)
- 유지보수성 (Class 구조 명확성)
- 반응형 구현 난이도
- 요청·제공 자료의 요구사항 충족도 (step001 기획 참조)
- 디자인 제외 목록 준수 (TOPIC `constraints`의 `디자인 제외` 줄. 제외 항목에 기대는 안은 감점)

결과: `step_archive/outputs/step002_설계선택.md` — 선택된 안과 이유 명시

### 3단계: 선택된 안으로 최종 설계 문서 작성 (에이전트 A)

에이전트 B가 선택한 안을 기반으로 최종 설계 문서를 작성한다.

합리적인 선에서 최대한 많은 서브에이전트를 병렬로 사용해야 한다 (동시 실행 최대 10개).

**설계 결과는 청크 단위로 저장한다:**

```
step002_레이아웃설계_chunk1.md (500줄 이하)
step002_전체설계_chunk1.md (500줄 이하)
step002_전체설계_chunk2.md (500줄 이하)
...
```

**작성 규칙**:

- 각 청크는 500줄 이하로 작성 (성능 최적화)
- 저장 후 각 청크가 500줄 이하이고 UTF-8(BOM 없음)인지 직접 확인한다. 자동 검증 훅은 번들되지 않는다.
- 청크 그대로 유지 (병합 안 함)

서브에이전트는 항상 haiku를 사용한다. (2026-06-10 정정: 헤더·CLAUDE.md 모델 매트릭스와 통일 — sonnet은 EVAL 게이트 평가자 전용)


## 시각 토큰·제외 계약 (필수)

최종 설계를 쓸 때 `step_archive/step002_레이아웃설계_chunk1.md`에 아래 형식의 계약 블록을 **정확히 하나** 둔다. 형식·항목 뜻·예외 규칙의 단일 원천은 플러그인 `docs/DESIGN-CONTRACT.md`다. 3·13단계와 평가자가 말하는 "선택된 디자인 토큰"과 "제외 목록"은 이 블록뿐이다.

```json harness50-design-contract
{
  "schema_version": 1,
  "tokens": {
    "colors": { "background": "#ffffff", "surface": "#f2f2f2", "text": "#1a1a1a", "accent": "#0b57d0" },
    "fonts": { "ui": "Helvetica Neue", "code": "JetBrains Mono" },
    "type": { "sizes": [14, 16, 20, 32], "weights": [400, 700] },
    "spacing": [4, 8, 16, 24, 32],
    "radius": [0, 4, 8],
    "shadow": []
  },
  "exclude": [
    { "id": "cream-background", "source": "host", "signature": "페이지 바탕(body·main·화면 루트)의 크림·아이보리·베이지·색조 있는 오프화이트", "adopted": false, "exception_reason": null }
  ]
}
```

- 위 값은 예시다. `tokens`는 선택된 안의 바탕·표면·본문·강조 1색, UI·코드 서체, 글자 크기(최대 4)·굵기(최대 2), 간격, radius, shadow를 헌법 §5 범위 안에서 고정한다. 구현 값은 모두 이 토큰에 매핑된다.
- `exclude`는 세 출처를 모두 담는다. `legacy` 5종(`generic-sans`, `purple-gradient`, `centered-cards`, `excess-radius`, `flat-background`), `host` 5종(`cream-background`, `italic-heading-accent`, `numbered-section-labels`, `monospace-labels`, `pill-buttons`), TOPIC `디자인 제외(사용자)` 줄의 각 항목(`topic-1`부터, `source: "topic"`, 원문을 `signature`에 보존). `signature`는 헌법 §5 표의 역할·CSS 문구를 쓴다.
- `legacy`·`host` 항목은 TOPIC이 그 스타일을 직접 요구했거나 선택된 미학(헌법 §5)이 그것 없이는 성립하지 않을 때만 `adopted: true`로 채택하고 `exception_reason`에 근거를 적는다. 같은 근거를 레이아웃 설계 본문에 `결정/사유: <id> 채택 — <사유>` 한 줄로도 남긴다. `topic` 항목은 채택하지 않는다.
- 제공된 예시가 제외 항목을 쓰면 계약이 우선한다. 그 요소는 설계에 넣지 않고 대체 방식을 적는다.

## CoVe (Chain-of-Verification)

설계 완료 후:
- [ ] 요구사항/기획의 모든 요구사항이 설계에 반영되었는가?
- [ ] 구현 가능한 설계인가?
- [ ] 이전 실패 패턴을 반복하지 않는가?
- [ ] 레이아웃 설계 chunk1에 `harness50-design-contract` 블록이 정확히 하나 있고, TOPIC 제외 줄의 항목이 모두 `exclude`에 있으며, 채택한 예외마다 `결정/사유` 줄이 있는가?

## 제공 API 계약과 미확정 요구

API를 사용하는 경우 사용자가 제공한 명세·자료 또는 명시적으로 선언한 계약에서
target, version, schema, auth, rate-limit, error, retry 정책을 추출한다. 요구 ID와
출처 파일·절·SHA-256을 연결한다. 누락된 필수 항목은 missing requirements로 남겨
차단하거나 명시적인 계약 결정을 받는다. 대상이 없으면 근거 있는 N/A를 기록한다.
추정한 최신 외부 사실이나 실행하지 않은 검증을 PASS로 기록하지 않는다.
테스트 결과는 선언한 계약의 동작 증거이며 외부 사실의 현재성을 증명하지 않는다.

## Jev 의미 체크포인트

설계 대안 둘의 구조·제약 설명이 준비되면 표현만 바꾼 안인지 실질적으로 다른 구조인지 묻는다. 세 대안 생성, 독립 선택자와 최종 설계 검증은 그대로 수행한다.

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

## 최종 독립 설계 검증

독립 검증자는 요구·선택·Class·async·접근성·토큰 계약과 각 청크 SHA-256을
입력부터 대조하여 `step_archive/outputs/step002_최종검증.md`에 최대5라운드를 기록한다.
필수 항목이 미해결이면 FAIL이며, 근거 있는 최종 PASS 후에만 환경을 준비한다.

## 설계 PASS 이후 환경 준비

선택된 통합 설계의 독립 PASS를 확인한 뒤에만 다음 환경 준비를 수행한다.

## 환경 확인과 설치

먼저 `step002_설계선택.md`, `step002_레이아웃설계_chunk1.md`,
`step002_전체설계_chunk1.md`가 같은 선택안을 가리키는지 확인한다. 프로젝트 루트에서
존재하는 모든 project manifest와 대응 lockfile을 식별하고, 선언된 package manager,
script, dependency와 현재 설치 상태를 읽는다. 없는 manifest나 lockfile을 발명하지
않고 서로 충돌하는 선언은 차단 사유로 기록한다.

선택된 설계에 필수인 프로젝트 의존성만 준비 대상으로 삼는다. 이미 선언되고 해석되는
의존성은 다시 설치하지 않는다. 누락된 필수 항목이 있을 때만 프로젝트가 선언한 package
manager의 명령을 제안하고 정상 권한 확인을 거쳐 실행한다. 각 항목은 최대 3회까지만
시도하며, 매 시도 뒤 실제 resolve, version, 최소 smoke 결과와 exit code를 확인한다.
세 번 안에 모두 검증되지 않거나 lockfile이 예상 밖으로 바뀌면 이 단계를 실패로 차단한다.

## 브라우저 검증 백엔드 선택과 고정

이 2단계의 마지막 환경 준비는 현재 실행의 브라우저 검증 백엔드와 잠금 파일을 소유한다. 먼저 사용자·호스트의
브라우저 제한과 플러그인 `docs/BROWSER-TOOLS.md`를 확인하고 허용된 백엔드만 선택한다.
브라우저 검증 백엔드는 프로젝트 의존성이 아니며 별도 검증 체크아웃에서 확인한다.
이미 유효한 `step_archive/outputs/browser-backend.json`이 있으면 그 selected 값만 사용한다.
잠금 파일이 손상되거나 선택값이 현재 명시 제약과 충돌하면 추정하거나 다른 백엔드로
넘어가지 않고 차단한다.

잠금 파일이 없는 새 실행은 선택한 백엔드의 실제 가용성을 확인한 뒤 정상 권한 흐름으로
아래 probe를 실행해 현재 프로젝트에 고정한다. `selected`가 null이 아니고 명령 종료 코드가
0이며 저장한 selected·tool_version이 관측한 결과와 같아야 완료할 수 있다.

```text
node "<validation-checkout>/scripts/verify-output.mjs" --probe --backend <selected> --lock --workspace "<project-root>"
```

프로젝트에 존재하는 잠금 파일은 `--probe --workspace "<project-root>"`로 같은 백엔드를
재확인한다. probe는 CLI/package 가용성만 확인하므로 선택한 백엔드의 정상 작동도 실제
최소 smoke로 확인한다. Aside의 경우 실행 중인 앱/데몬에 연결되는지 확인한다. 사용 가능한
것처럼 추정하지 않으며 명령·버전·smoke 결과·종료 코드와 selected 값을 환경 보고서에 남긴다.
필수 가용성을 검증할 수 없으면 최대 3회 정상 권한의 필요한 복구만 시도한 뒤 차단한다.
다른 백엔드의 package나 browser binary를 설치하지 않고 사용자 승인 없는 백엔드 변경은
하지 않는다. 잠금 파일에는 비밀·원시 환경 변수·인증 정보를 기록하지 않는다.

이후 브라우저 검증(Step 9·14 포함)은 같은 잠금 파일만 사용한다. 환경 준비 보고서
`step_archive/step002_환경준비.md`와 잠금 JSON은 현재 실행의 필수 산출물이다.

`step_archive/step002_환경준비.md`에는 선택 설계 digest, 발견한 manifest와 lockfile,
필수 의존성 근거, 실행한 정확한 명령과 exit code, resolve 경로, version, smoke 결과,
변경된 선언 파일을 기록한다. 환경 변수 원문이나 credential은 기록하지 않는다.

## 환경 준비 독립 검증

독립 검증자는 설계에 없는 패키지가 추가되지 않았는지, 선언된 package manager와
lockfile이 유지됐는지, 모든 필수 항목의 resolve·version·smoke 증거가 일치하는지
처음부터 대조한다. 실패나 미확인을 `PASS`로 바꾸지 않는다.

## 현재 실행에 결합된 환경 관측 기록

독립 설계 검증 `step002_최종검증.md`의 PASS가 먼저 있어야 한다. 설계 PASS는 환경
완료를 뜻하지 않으며, 환경 준비가 실패하면 2단계 전체가 미완료다. 최종 설계 검증 보고서는
검증자·독립성 근거·현재 설계 해시·실제 판정 근거를 기록하고 마지막 비어 있지 않은 줄에
정확히 `final-verdict: PASS`를 한 번 둔다. 실패 시 같은 위치에 `final-verdict: FAIL` 또는
`final-verdict: INCOMPLETE`를 기록한다. 환경 검사는 판정과 현재 digest를 확인하며 검증자의
독립성을 인증하거나 설계 검증을 대신하지 않는다. 환경 보고서에는
명령·종료 코드·시도 수·resolve/version/readiness 결과를 기록하고 아래 JSON 블록을
정확히 하나 둔다. 값은 실제 관측과 현재 관리자의 profile/generation으로 채운다.
`workflow_generation`은 신뢰한 `workflowContext`/보고기 반환값을 사용하며 임의로 만들지 않는다.

```json harness20-environment
{
  "schema_version": 1,
  "workflow_profile": "planning-first-14-v1",
  "workflow_generation": "<current-workflow-generation-sha256>",
  "selected": "aside",
  "tool_version": "<observed-version-matching-lock>",
  "browser_ready": true,
  "dependencies_ready": true,
  "backend_lock_sha256": "<sha256-of-current-browser-backend-json>",
  "selected_design_sha256": "<sha256-of-current-step002-design-selection>",
  "final_design_verification_sha256": "<sha256-of-current-final-design-verification-report>",
  "layout_design_sha256": "<sha256-of-current-layout-design-chunk1>",
  "overall_design_sha256": "<sha256-of-current-overall-design-chunk1>"
}
```

브라우저/의존성의 실제 성공을 확인한 경우에만 각각 true로 기록한다. 설치가 불필요하면
기존 의존성의 실제 resolve/version/smoke와 근거를 기록한다. 아래 검사는 저장된 관측과
현재 파일·실행의 결합을 검증하며 도구 실행이나 readiness 측정을 대신하지 않는다.

```text
node "<plugin-root>/scripts/environment-report.mjs" inspect --workspace "<project-root>"
```

종료 코드 0과 current/PASS, 환경 보고서·유효 잠금·현재 선택 설계의 일치가 완료 조건이다.
이 CLI와 두 호스트의 완료 경계는 누락·손상·실패·이전 실행 자료를 거부한다.

## Self-Calibration

- 이 설계를 그대로 구현해도 되는가? (Y/N)
- N이면 해당 부분을 재설계한다.

## 오류 발생 시

오류 발생 시 원인을 분석하고 수정한 뒤 재시도한다. 3회 재시도 후에도 해결되지 않으면 오류·미해결 항목·다음 검사를 현재 Step 결과 파일에 기록하고 현재 Step을 INCOMPLETE로 인계한다. 완료 보고와 다음 Step 진입은 금지하고 헌법 §2-1 명명된 멈춤으로 끝낸다(필수 도구 실패 `required-tool-failed`, 권한 거부 `permission-denied`, 그 밖의 한도 소진 `required-input-missing`). 선택 도구를 쓸 수 없는 것은 미달이 아니다 — `SKIP`과 사유를 기록한다.


---

필수 요구와 현재 검증 증거가 모두 PASS일 때만 이 지침을 완료하고 자동으로 step003.md를 읽고 수행한다. 사용자 확인을 기다리지 않는다.


## 정의별 입력·산출물 계약

- 입력: `step_archive/TOPIC/TOPIC.md`
- 입력: `step_archive/step001_planning_chunk1.md`
- 입력: `step_archive/outputs/step001_검증.md`
- 산출물: `step_archive/outputs/step002_설계대안.md`
- 산출물: `step_archive/outputs/step002_설계선택.md`
- 산출물: `step_archive/step002_레이아웃설계_chunk1.md`
- 산출물: `step_archive/step002_전체설계_chunk1.md`
- 산출물: `step_archive/outputs/step002_최종검증.md`
- 산출물: `step_archive/step002_환경준비.md`
- 산출물: `step_archive/outputs/browser-backend.json`

필수 수락 항목: `design-alternatives`, `design-selection`, `layout-design-chunk-1`, `overall-design-chunk-1`, `final-design-verification`, `structured-brainstorming-first`, `independent-selector`, `class-architecture-contract`, `async-lifecycle-contract`, `responsive-accessibility-contract`, `design-exclusion-contract`, `design-chunks-bounded`, `pass-verdict`, `provided-api-contract`, `environment-preparation-report`, `selected-design-and-manifests`, `required-dependencies-only`, `bounded-resolution-smoke`, `permission-preservation`, `browser-backend-lock`, `bounded-browser-readiness`
