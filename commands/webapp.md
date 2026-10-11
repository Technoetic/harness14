---
description: 웹앱 인터랙티브 튜토리얼 1회 입력 → 기획부터 새14단계 자율주행, 기존36·50단계 호환. /webapp <주제>
argument-hint: <주제 한 줄>
---

# /webapp — harness14 자율주행 시작

**입력**: `$ARGUMENTS` (예: `다익스트라 최단경로 알고리즘`, `OAuth 2.0 인증 흐름`, `B-tree 인덱스`)

**실행 전 분기:** 직접 Jev 질문이나 유지 중인 Jev-first 선호에 따른 일반 질문만
요청됐으면 아래 **Jev-first 요청 라우팅**으로 답하고 종료한다. workflow 제어를
요청하지 않은 경우 즉시 실행 절차에 들어가거나 TOPIC·progress를 만들지 않는다.
웹앱 시작·재개 등 실제 제어 요청이 있을 때만 다음 절차를 수행한다.
자연어 요청은 자동 시작하지 않는다(시작은 `/webapp <주제>`).

**Codex 작업 공간 분기:** `step_archive/.harness50-codex/state.json`이 있으면 Codex 상태
관리자가 이 작업 공간을 소유한다. 아래 절차를 수행하지 않는다. TOPIC.md·progress.json을
만들거나 덮어쓰지 않고, step001로 돌아가지도 않는다. SessionStart나 webapp-trigger가 알린
Codex 단계부터 harness14 플러그인의 `codex/scripts/harness-state.mjs`(`show` → `resume` →
`begin` → `complete`)와 `codex/skills/webapp/SKILL.md` 절차로 이어간다. 다른 주제는 별도
작업 공간에서 시작한다. 상태 파일을 읽을 수 없으면 `show` 결과만 보고하고, 복구나 리셋은
사용자가 결정한다.

## 즉시 실행 절차 (사용자 확인 없이)

1. **harness-rules skill 로드** — 본 세션의 절대 헌법.
   `Skill` 도구로 `harness14:harness-rules` 호출.

2. **선택된 실행 확인** — 명시적인 `/webapp <주제>`의 `webapp-trigger`가 새 실행에 schema2·`planning-first-14-v1`·total14을 만들고 원문 prompt를 TOPIC에 보존한다. `webapp trigger skipped`가 있으면 TOPIC·progress를 덮어쓰지 않고 안내만 전한다. 훅 실패로 진행 기록이 없으면 필수 도구 실패로 보고하고 가짜 progress를 직접 만들지 않는다.

   ```
   node "<plugin-root>/hooks/lib/workflow-profile.mjs" resolve "<project-root>"
   ```

   성공 출력의 `workflow_profile`, `total`, `step_body`, `body_directory`, `milestones`를 사용한다. 실패하면 경로·프로필·총수를 추측하지 않는다. 명시적 기존36과 legacy50은 원래36·50 본문과 번호를 유지한다. 첫 기획은 TOPIC과 명시 제공 자료를 검토하며 삭제된 선행 gate나 도구 보고서를 요구하지 않는다.

3. **본문 Read** — 반환된 `step_body`를 읽는다. 새14의 경로는 `step_archive/profiles/planning-first-14-v1/archived/stepNNN.md`다. 기존36은 `step_archive/profiles/research-free-36-v1/archived/stepNNN.md`, legacy50은 검증된 archived/ 또는 flat 경로다. 새 본문을 legacy 경로에 복사하지 않는다.

   TOPIC의 constraints에는 네 프로필 모두 다음 기본 줄을 그대로 유지한다. 사용자 제외는 별도 줄에 원문으로 보존하며, 채택 예외는 선택된 설계 단계(새14의2 / 기존36의18 / legacy50의30)가 계약에 근거를 기록한다.

   - 디자인 제외(하네스 기본, 설계가 채택 사유를 기록하면 예외): 크림·오프화이트 페이지 바탕 / 제목 속 이탤릭 강조어 / 01·02·03 장식 번호 섹션 라벨 / 코드 밖 모노스페이스 라벨 / 알약형 버튼 / 맹목적 Inter·Roboto·Arial / 보라 계열 그라데이션 배경 / 무조건 중앙정렬 카드 / 과도한 border-radius / 획일적 단색 배경

4. **연속 실행** — 본문 지시대로 실행 → `Step NNN/<total> 완료` 보고 → 같은 프로필의 다음 본문을 Read한다. 새14은 `Step 001/14 완료`부터 `Step 014/14 완료`, 기존36은 원래 `/36`, 기존50은 원래 `/50`을 사용한다. 선택된 최종 단계 전에 종료하려면 헌법 §2-1 명명된 멈춤을 기록한다. 최종 `quality-gate.mjs --inspect-final` 종료 코드0을 확인한 뒤 `node "<plugin-root>/scripts/final-summary.mjs" --workspace "<project-root>"`를1회 실행하고 완료 줄 뒤에 출력의 세 제목만 붙인다.

## Jev-first 요청 라우팅

사용자가 Jev-first 또는 가능한 판단을 Jev에 먼저 맡기도록 요청하면, 유지 중인
선호·승인 범위를 포함해 **현재 요청의 모든 지원되는 판단**에 먼저 적용한다.
쉽거나 명백한 질문, 산술, 일반 대화, 선택된 체크포인트 밖이라는 이유로 생략하지 않는다.
독립 질문·명시적으로 선택한 인라인 텍스트는 설치 플러그인의 `scripts/jev-ask.mjs`
`prepare --input -` 다음 `run --input - --allow-network`로 처리한다.
워크스페이스나 가짜 근거 파일을 만들지 않는다. 입력·타입·결과 계약은
`docs/jev-first.md`를 따른다. 직접 질문만 처리하는 요청은 workflow를 시작하지 않는다.

Noul은 명제의 참 확률, Choice는 근거 부족 선택지를 포함한 후보 선택,
Score는 순서 있는 2–10개 기준의 가중 평점이다. Noul에 제공되지 않은 confidence를
붙이거나 Score를 임의 숫자 생성기로 사용하지 않는다. 필요한 최신·환경 근거를
먼저 수집하고, 근거가 부족한 질문은 보류 가능한 Choice를 우선 사용한다.
자유 글·코드·이미지 생성과 실제 도구·브라우저·파일·테스트 실행은 호스트가 담당한다.
혼합 요청은 지원되는 판단과 호스트 실행으로 나누고 검증된 자료만 평가한다.

이미 승인된 평범한 비밀 없는 질문의 전송 범위는 재사용하며 매번 재확인하지 않는다.
전체 대화·워크스페이스·숨은 자료를 자동 수집하거나 파일 제한을 인라인 재분류로
우회하지 않는다. 파일에서 파생된 판단에는 아래 기존 파일 경로를 우선 사용한다.
현재 파일 보고서가 같은 질문을 답했으면 직접 호출을 추가하지 않는다. 직접 결과도
현재 `prepare`의 `input_hash`, `request_hash`, `policy_hash`가 일치하면 재사용한다.
한 책임자만 변하지 않은 요청에 한 배치를 호출하며 자동 재시도하지 않는다.
실제 검증된 응답에는 짧게 `Jev 사용`을, 미호출·미지원·실패에는
`호스트 처리: <이유>`를 표시한다. 낮은 확신·abstain은 검토 대상으로 남긴다.
기존 권한·독립 검증·필수 테스트·완료 writer는 그대로 적용한다.

## Jev 체크포인트 라우팅

새14은1·2·3·9·13단계, 기존36은17·18·25·31·35단계, legacy50은16·24·25·30·37·45·49단계의 선택 근거가 준비되면 신뢰한 설치 플러그인의
`scripts/jev-judge.mjs`와 `docs/jev-checkpoints.md`를 따른다. 현재 작업에서 Jev 사용과
해당 발췌문의 외부 전송이 승인된 경우 자동 호출한다. 기존 승인이 범위를 포함하면
재확인하지 않는다. 단계 도달이나 키 존재, workflow 시작 자체는 전송 승인이 아니다.
승인 또는 서비스가 없으면 이유를 단계 보고서에 남기고 기존 독립 검증을 수행한다.

호출 책임자를 그 단계를 실행하는 주체 하나로 정하고(보통 step-executor, 시각 판정을 돌려받은 단계는 판정하는 호출자) 승인 범위와 선택 근거를 인계한다.
워커가 반환한 보고서는 `inspect`하고 현재 `prepare`의 `request_hash`, `policy_hash`,
`input_hash`, `sources`를 대조한다. 재사용할 판정이 없을 때만 같은 JSON으로
`run --workspace ROOT --input - --allow-network`를 실행한다. 변하지 않은 입력에는
한 배치만 호출하는 호스트 정책이며 전역 하드 쿼터가 아니다. 호출자와 워커는 중복 호출하지 않는다.
일반 웹 탐색 권한은 늘어나지 않는다. abstain·낮은 confidence는 호스트 검토 대상으로 남기고
Jev 결과로 기존 필수 Acceptance·시각 검사·E2E·독립 검증·완료 writer를 대체하지 않는다.

## 절대 준수

- 사용자에게 질문하지 마라. 예외는 헌법 §2-1 명명된 멈춤 보고 한 줄과 §2 선택된 최종 단계 요약의 `## 사용자 확인 필요` 절뿐이다
- "진행할까요" / "어떻게 할까요" / "다음 턴에서 재개" 모두 금지
- 토큰 한도 직전까지 한 턴 안에서 가능한 한 많은 step 실행
- Stop hook이 자동 재개를 처리하므로 인위적으로 턴을 끊지 마라. 선택된 최종 단계 전에 끝낼 수 있는 길은 `permission-denied`·`required-tool-failed`·`required-input-missing` 멈춤을 `scripts/harness-pause.mjs pause`로 기록하는 것뿐이다
- 각 step 완료는 1줄 보고 ("Step NNN/<total> 완료")만. 단 선택된 최종 단계는 완료 줄 다음에 `final-summary.mjs` 출력의 세 제목(`## 사용자 확인 필요` / `## 변경` / `## 발견`)만 덧붙인다 (헌법 §2 예외)
- 멈춘 작업은 이 명령으로 재개하지 않는다(재개는 `/harness-resume`). `/webapp <주제>`는 완료 기록이 있는 진행을 건드리지 않고 건너뛴다. 새 주제는 `/harness-reset` 후 `/webapp <주제>`

## 다음 행동

새 실행은 관리자가 선택한 step001 요구사항 기획부터 시작하라. 기존 실행은 반환된 현재 단계부터 이어간다. 본 명령어는 이미 자율주행 진입 신호다.
