---
description: harness14 진행 상태 리셋 — 완료 기록을 지우고 1단계의 새 실행을 user-request 멈춤으로 대기시킨다. step_archive/archived/ 본문과 TOPIC.md는 건드리지 않는다.
---

# /harness-reset

1. `step_archive/.harness50-codex/state.json`이 있으면 이 작업 공간은 Codex 상태 관리자가 소유한다.
   progress.json을 만들거나 덮어쓰지 않고, 다음 1줄만 보고하고 종료한다: `harness14: Codex workflow 작업 공간 —
   Claude progress는 리셋하지 않음. Codex workflow 리셋은 Codex의 $harness14-reset으로 사용자가 직접 실행`.
2. 그 외에는 harness14 플러그인의 멈춤 CLI를 한 번 실행한다. `step_archive/progress.json`을 직접 편집하지 않는다.

   ```
   node "<plugin-root>/scripts/harness-pause.mjs" reset --workspace "<project-root>"
   ```

   `<plugin-root>`는 이 명령 파일이 든 harness14 플러그인 폴더(`commands/`의 상위), `<project-root>`는 현재
   프로젝트 루트다. CLI는 progress.json을 선택된 프로필과 본문 의미를 유지한 1단계·완료 없음의 새 실행으로 원자적으로 바꾸고
   `run_started_at`(UTC)을 새 실행 경계로 적는다. 그리고 `user-request` 멈춤(`paused_step` 1, 메모
   `리셋 후 대기 — /webapp <주제>로 새 실행, /harness-resume으로 현재 주제를 1단계부터`)으로 대기시킨다.
   새14은 schema2·`planning-first-14-v1`·total14, 기존20은 schema2·`planning-first-20-v1`·total20, 기존36은 schema2·`research-free-36-v1`·total36, legacy50은 원래50을 유지한다. 읽을 수 없거나 프로필·총수가 불일치한 progress.json은 변경하지 않고 실패한다. 이 경우 알려진 기존 기록에서 일관된 metadata와 프로필 표식을 복구한 뒤 다시 리셋한다. 프로필을 추측하거나 과거 기록을 재번호화하지 않는다. 이전 멈춤과 `pause_history`, 세션 기록은 지운다.
3. 결과로 1줄만 보고한다.
   - exit 0: `harness14 리셋 완료 — 새 주제는 /webapp <주제>, 현재 주제를 1단계부터 다시 하려면 /harness-resume`
   - exit 2이고 `error.code`가 `PAUSE_NO_WORKFLOW`이면(progress.json 없음, 새로 만들지 않음):
     `harness14: 리셋할 진행 기록 없음 — /webapp <주제>로 시작`
   - 그 밖의 실패는 stderr JSON의 `error.code`를 그대로 쓴다. 예: `harness14 리셋 불가 — PAUSE_STATE_INVALID`.
4. 이 턴에서는 step을 진행하지 않는다. 추가 출력·확인 질문 금지.

## 리셋 뒤 대기하는 이유

리셋한 턴의 Stop에서 자동 이어가기가 보존된 TOPIC.md의 옛 주제로 1단계를 시작하지 않게 한다. 진행 기록 훅은
`run_started_at` 이전의 대화에 남은 옛 `Step NNN/<total> 완료` 줄을 세지 않는다. 완료 기록이 없으므로 이어서
`/webapp <주제>`는 새 주제로 시작하고(멈춤 없이, 새 `run_started_at`), `/harness-resume`은 현재 주제를 1단계부터
진행한다. 새 `/webapp <주제>`는 기본14를 명시하여 시작하며 기존20·36·50 완료 기록을 재번호화하지 않는다. 멈춘 작업을 이어가려면 리셋하지 말고 `/harness-resume`을 쓴다.

## 보존 대상 (삭제 금지)

- 선택된 본문: 새14 `step_archive/profiles/planning-first-14-v1/archived/step001~014.md`, 기존36 `step_archive/profiles/research-free-36-v1/archived/step001~036.md`, legacy50 `step_archive/archived/step001~050.md`와 기존 flat 본문 (그대로)
- `step_archive/specs/SPEC-*.md` (자동 생성된 SPEC들)
- `step_archive/outputs/` (Trust5 결과 `trust5_r*.md`, 이전 `final-summary.md` 포함)
- `step_archive/TOPIC/TOPIC.md` (사용자가 명시 삭제 요청 시에만)
