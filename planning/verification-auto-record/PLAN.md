# Plan: verification-auto-record

Session: `verification-auto-record` · Repo: `app-vitals/shipwright`

## Problem

Per-check verification outcomes (`POST /verification-checks`) stopped being
recorded after the agent moved to `claude-sonnet-5-5` on 2026-10-02 (69 of 70
dev-task/patch sessions since record nothing; ~30% of sessions recorded on
2026-10-01 under `claude-sonnet-5`). Neither skill text, plugin version,
task-store, nor token changed. The recording is ~100 lines of prose-embedded
bash per skill (and four copies in `patch.md`) that the model skips or
improvises around — in the same sessions it also never used the
`run-with-budget.ts` wrapper or set a Bash `timeout`. The admin agent-detail
"Recent Verification Activity" card hides itself when there is no data, so it
is blank for every agent.

## Design (decided with Dan)

Replace the scripted budget + recording machinery with a short, plain-language
verification step, and see whether that is any better **before** adding hooks
or harness-side checks (commands come in too many shapes to parse safely).

Step 8 (dev-task) and the validate sites (patch Steps 4b/5b/6c) say, in prose:

1. Verifications are crucial to ensuring your work is valid.
2. Run the discovered verifications (install, lint, typecheck, test — however
   each skill currently iterates/discovers them), setting the Bash tool's
   `timeout` to 600000 ms. If a verification exceeds 10 minutes, skip the local
   run for it and rely on CI.
3. Record every outcome — passes, failures, skips, timeouts — to
   `POST /verification-checks`, so systemic issues blocking local
   verification can be tracked and fixed. The step lists the API contract:
   - parent: exactly one of `taskId` (dev-task) or `prId` (patch)
   - `repo`, `checkName`, `status`: `ran_passed | ran_failed | skipped | timed_out`
   - optional `reasonCategory` (only with `skipped` / `timed_out`; never with
     `ran_passed` / `ran_failed`): `check_timeout`, `install_timeout`,
     `resource_limit`, `missing_tool`, `missing_secret`, `missing_dependency`,
     `not_configured`, `learned_skip` (with `learnedFromCategory` = the
     category being carried forward)
4. Simplified learned proactive skip: before a check, `GET
   /verification-checks?repo=&checkName=&limit=` and if the two most recent
   rows for that repo+check are `skipped`/`timed_out`, skip it locally and
   record `skipped` / `learned_skip` carrying `learnedFromCategory`. No
   scripts; a few lines of prose + one curl.

Deleted: `plugins/shipwright/scripts/run-with-budget.ts` + its integration
test; the "Enforced, Process-Group-Aware Timeouts" section and `setsid`/
`timeout --kill-after` prose; the `VC_BODY` classification bash; the
CI-duration budget derivation; the long streak-walk in both skills; doc
references. Untouched: task-store route/schema/OpenAPI and the admin card
renderer (apart from the empty state in VAR-2.1). `planning/*` references to
the script are historical and stay.

Not in scope: native Claude Code hooks, harness-side post-run recording,
pinning the model. Revisit after measuring (compare the share of dev-task/patch
sessions that record anything against the 2026-10-01 ~30% baseline).

## Tasks

| Task | Title | Depends on | Hours | Model | Branch |
|---|---|---|---|---|---|
| VAR-1.1 | Simplify dev-task Step 8: 10-min Bash timeout, record all outcomes, drop wrapper/recording scripts | — | 3 | sonnet | feat/var-1-1-simplify-dev-task |
| VAR-1.2 | Simplify patch validate sites (4b/5b/6c) the same way, recording by `prId` | — | 4 | sonnet | feat/var-1-2-simplify-patch |
| VAR-1.3 | Delete `run-with-budget.ts`, its integration test, and doc references | 1.1, 1.2 | 2 | haiku | feat/var-1-3-delete-run-with-budget |
| VAR-2.1 | Admin: show an empty state instead of hiding the verification activity card | — | 2 | sonnet | feat/var-2-1-verification-card-empty |

All tasks are safe to deploy standalone (no renames/removals with live
consumers beyond VAR-1.3, which depends on the two that remove the call sites).
No task is HITL.

## Dependency map

```
[START]
  ├─ VAR-1.1 (no deps)
  ├─ VAR-1.2 (no deps)
  │     └─ VAR-1.3 (needs 1.1, 1.2)
  └─ VAR-2.1 (no deps)
```
