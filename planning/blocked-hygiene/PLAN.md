# Plan: blocked-hygiene

Repo: app-vitals/shipwright

Two pipeline bugs found while triaging RCN-8.10 (a downstream repo's secret-scan and Deploy runs failing in actions/checkout on a main push).

## Technical design

### Bug 1: infra flakes escalated as post-merge CI failures
`plugins/shipwright/commands/merge.md` Step 4 ("Failed run" branch) blocks every merged task as soon as any latest-per-workflow run has a terminal non-green conclusion. A transient GitHub failure in `actions/checkout` (`Repository not found`, exit 128, before any repo code runs) is therefore escalated like a real failure, and nothing retries it.

- Add a small tested helper next to `plugins/shipwright/scripts/is-ci-green.ts` that classifies a failed run as an infra flake from its job/step data and log. Signature: the failing step is `actions/checkout`, or the log matches `Repository not found` / `exit code 128` before any repo code ran, or the conclusion is `startup_failure` / a runner shutdown.
- In `merge.md`, on a flake-classified failure, rerun the failed jobs once (`gh run rerun {id} --failed`) and resume the poll loop. Reruns are tracked in a per-watch `RERUN_IDS` list (one rerun per run ID). The single 10-minute / 20-poll cap from the start of the watch still applies: a rerun does not open a fresh window (that would be unbounded when several workflows flake), and if the cap runs out while the rerun is pending the watch falls to the pending-at-timeout branch, which leaves tasks `merged`. `RUNS_JSON` does not select `run_attempt`; a rerun keeps the run ID, so seeing a `RERUN_IDS` entry in a terminal non-green state again means the rerun also failed. Keying the cap on `run_attempt > 1` was rejected because it would block, without retrying, a run someone had already re-run manually. Shipped in #5232.
- If the rerun also fails, block with `Post-merge CI failed (infra, rerun exhausted) — run ID: {id}`. The existing `Post-merge CI failed` substring is preserved so `unblock.md` still infers the merge origin phase. The reason also states whether the failed job was a scan that never ran or a scan that ran and failed.
- Content test in `merge.content.test.ts` locks in rerun-once and the reason string.

### Bug 2: blocked flags never cleared on terminal PRs
`task-store/src/pull-request-service.ts` (PR update path, ~line 600) clears claim fields on a transition to `merged`/`closed` but never touches `blocked` / `blockedReason`.

- `closed`: always clear the same field set as `unblock()` (`blocked`, `blockedReason`, `blockedHeadSha`, `skipCount`, `lastSkippedAt`, `consecutiveCiFailureCount`, `lastCiFailureSignature`). Preserve the `lastAutoBlock*` history.
- `merged`: clear the same `unblock()` field set (`CLEARED_BLOCK_FIELDS`) only when `blockedReason` matches a patch-phase reason, via `isPatchPhaseBlockReason()` and `PATCH_PHASE_REASON_MARKERS` (`task-store/src/pull-request-service.ts`), which is the source of truth for the reason list. Anything else is kept by default, including `Post-merge CI failed` and unknown reasons. Shipped in #5242.
- No backfill task. Existing stale records are handled, if at all, by a one-off cleanup through the existing `POST /prs/:id/unblock` endpoint after the fix ships.

## Tasks

| Task | Depends on | Blocks | HITL |
|---|---|---|---|
| BKH-1.1 | — | 1.2 | |
| BKH-1.2 | 1.1 | — | |
| BKH-2.1 | — | — | |

BKH-1.1 and BKH-1.2 share a branch (bundle). BKH-2.1 is standalone.

## Breaking Change Safety
All tasks are additive or behavior-narrowing; no renames, removals or constraint additions. Safe to deploy standalone: yes.

## Not carried
- Backfill of existing stale blocked PR records: deliberately dropped per Dan; optional one-off cleanup via the existing unblock endpoint.
