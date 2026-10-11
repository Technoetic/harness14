---
description: harness14 진행 상태 조회 — 현재 step / 완료 step 수 / Trust5 결과
---

# /harness-status

Codex 상태가 없고 progress가 있으면 신뢰한 설치 플러그인의
`node "<plugin-root>/hooks/lib/workflow-profile.mjs" resolve "<project-root>"`로 프로필과
본문 바인딩을 검증한다. 반환된 `total`(새14·기존36·legacy50)과 `next_step`을 기준으로
`step_archive/progress.json`의 완료 수·멈춤 필드를 읽어 한 줄로 보고한다.
불일치·손상은 1줄 오류로 보고하며 프로필을 추정하거나 상태를 수정하지 않는다.

```
harness14: <completed>/<total> 완료 | current=<stepNNN 또는 -> | r1=<판정> r2=<판정> r3=<판정>
```

- current는 첫 미완료 Step이다. 선택된 전체 단계 수만큼 완료면 `-`로 쓴다.
- `paused`가 있고 `false`가 아니거나 `status`가 `paused`이면(명명된 멈춤, 헌법 §2-1) 줄 끝에
  ` | 멈춤: <pause_reason> @step<paused_step> — <pause_note>`를 붙인다. pause_reason이
  `permission-denied`·`required-tool-failed`·`required-input-missing`·`user-request`가 아니면 `unknown`,
  paused_step이 없거나 범위 밖이거나 첫 미완료 Step보다 작으면 첫 미완료 Step을 쓴다(멈춘 턴에 보고한 완료는
  멈춤 기록 뒤 그 턴의 Stop에서 기록되므로 저장된 paused_step이 뒤처질 수 있다).
- progress.json 없으면: "harness14 비활성 — /webapp <주제> 로 시작"
- 단, `step_archive/.harness50-codex/state.json`이 있으면 progress.json 대신 harness14 플러그인의
  `node "<plugin-root>/codex/scripts/harness-state.mjs" show --workspace "<project-root>"` 결과(`status`, `current_step`,
  완료 수와 `total_steps`)로 `harness14 (Codex): <status> | current=<stepNNN 또는 -> | <completed>/<total> 완료`를 보고한다.
  `current_step`이 null이면(완료된 워크플로 등) `current=-`로 쓴다.
  이 경우 progress.json 유무로 비활성이라고 판단하지 않는다.
- <판정>은 step_archive/outputs/trust5_rN.md의 `Verdict:` 줄 값(PASS·FAIL·INCOMPLETE), 파일이 없으면 `-`. 점수(예: 42/50)는 쓰지 않는다(docs/QUALITY.md)

추가 출력 금지. 1줄 보고만.
