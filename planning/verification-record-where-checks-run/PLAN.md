# Plan: verification-record-where-checks-run

Session: `verification-record-where-checks-run` · Repo: `app-vitals/shipwright`
Follow-up to session `verification-auto-record` (VAR-1.1/1.2/1.3/2.1, deployed 2026-10-08, plugin 1.393.0).

## Problem

After VAR shipped, there are still no new `/verification-checks` rows since
2026-10-02. Of ~12 post-deploy dev-task sessions none POSTed and only 1 printed
the PRE-SHIP table; patch runs also recorded nothing (no row has ever had a
`prId`). Step 8 sits deep in a ~1,400-line dev-task.md after Step 5, and by then
the implementation subagent has already run the validation. Findings:

- dev-task's Step 5 implementation brief, [F] Validation, says only
  "Run: {validate command}" — no recording instruction, no timeout rule — so
  the subagent that actually runs the checks is never told to record them, and
  Step 8 is redundant to the main thread.
- patch's fix-subagent briefs ([C] Validate in Steps 4b/5b/6c) already carry the
  full recording instruction (VAR-1.2) and still produced zero rows, so a second,
  harder-to-skip prompt point is needed there.
- Implementation/fix subagent transcripts are not retained in the session logs,
  so subagent behavior cannot be observed directly (blind spot).

## Design (prose only — keep it simple, per Dan)

Try two changes together before any hooks / harness / scripts:

1. **dev-task brief [F]:** add the recording block to the Step 5 implementation
   brief — the same wording patch's [C] Validate already carries (600000 ms Bash
   timeout, skip-and-rely-on-CI past 10 minutes, record every outcome, status
   values, reasonCategory list, learned-skip), with `taskId` as the parent.
2. **Required pre-push gate (never blocks shipping):** immediately before
   `git push` — dev-task Step 9, and inside each patch fix-subagent brief
   (Steps 4b/5b/6c) just before `git push origin {branch}`:
   `GET /verification-checks?taskId={id}` (patch: `prId={PR record id}`) with
   `limit=1`; if empty, record each check that was run (or skipped, and why) now,
   then continue. Gate wording is word-for-word identical across all four sites.

No scripts are reintroduced. Content tests are updated alongside each change.

Not in scope / deferred: PostToolUse hook, harness-side post-run recorder,
subagent report-back block, a tracked measurement task. If recording is still
absent after these ship, those are the next options. (Informal check: compare
the share of dev-task/patch sessions that record anything against the
2026-10-01 ~30% baseline.)

## Tasks

| Task | Title | Depends on | Hours | Model | Branch |
|---|---|---|---|---|---|
| VRW-1.1 | dev-task: recording block in Step 5 brief [F] + required pre-push gate in Step 9 | — | 3 | sonnet | feat/vrw-1-1-dev-task-record-gate |
| VRW-1.2 | patch: required pre-push verification gate in the 3 fix-subagent briefs | — | 3 | sonnet | feat/vrw-1-2-patch-record-gate |

Both are independent and safe to deploy standalone (additive prose + test
assertions). Neither is HITL.

## Dependency map

```
[START]
  ├─ VRW-1.1 (no deps)
  └─ VRW-1.2 (no deps)
```
