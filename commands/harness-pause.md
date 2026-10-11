---
description: harness14 자동 이어가기 멈춤 — 사용자 요청을 명명된 멈춤(user-request)으로 기록한다. 진행 기록은 보존한다.
argument-hint: [사유 한 줄]
---

# /harness-pause

**입력**: `$ARGUMENTS` (선택, 멈추는 이유 한 줄)

1. `step_archive/.harness50-codex/state.json`이 있으면 이 작업 공간은 Codex 상태 관리자가 소유한다.
   아무것도 쓰지 않고 다음 1줄만 보고한다: `harness14: Codex workflow 작업 공간 — Codex의 $webapp pause를 사용`
2. 그 외에는 harness14 플러그인의 멈춤 CLI를 한 번 실행한다. `step_archive/progress.json`을 직접 편집하지 않는다.

   ```
   node "<plugin-root>/scripts/harness-pause.mjs" pause --workspace "<project-root>" --reason user-request --note '<메모>'
   ```

   - `<plugin-root>`는 이 명령 파일이 든 harness14 플러그인 폴더(`commands/`의 상위), `<project-root>`는 현재 프로젝트 루트다.
   - `<메모>`는 `$ARGUMENTS`에서 줄바꿈과 작은따옴표를 빼고 한 줄 200자 이내로 줄인 것이다. 비어 있으면 `사용자 요청으로 자동 진행 중지`를 쓴다.
     작은따옴표로 감싸므로 `$(...)`·백틱·`$VAR`는 bash와 PowerShell에서 전개되지 않고 글자 그대로 기록된다.
3. 결과로 1줄만 보고한다: `harness14 멈춤 — step<NNN>에서 자동 진행 중지. 재개: /harness-resume`
   (`<NNN>`은 출력 JSON의 `paused_step`을 세 자리로). 이미 멈춰 있어도(`changed:false`) 같은 줄이다.
   exit 2면 stderr JSON의 `error.code`를 그대로 1줄로 보고한다. 예: `harness14 멈춤 불가 — PAUSE_NO_WORKFLOW`.
4. 이 턴에서는 step을 진행하지 않는다. 추가 출력·확인 질문 금지.

멈춤 규칙 전문은 harness-rules 헌법 §2-1이다. 멈춘 동안 Stop 훅은 실행을 다시 지시하지 않고(진행 기록 훅은 멈춘 턴에
보고된 완료 줄만 기록한다), 세션 시작과 프롬프트마다 `[HARNESS] PAUSED at stepNNN/<total>` 한 줄로 멈춘 위치만 알린다. `<total>`은 CLI/resolver의 `total`(새14·기존36·legacy50)이며 프로필을 추정하지 않는다.
