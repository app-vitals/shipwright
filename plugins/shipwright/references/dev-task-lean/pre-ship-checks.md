# Pre-ship checks (Step 8)

Moved from `commands/dev-task.md`.

## No scheduled wakeups
Run long commands synchronously (chain Bash calls, or poll via Monitor in-session). A session that ends stops heartbeating;
past the ~65-minute TTL (`DEFAULT_CLAIM_TTL_MS`) the `StaleClaimReaper` resets the task and the next cron re-bootstraps with
no memory (AGH-1.1 incident: a wakeup failed silently after local tests and left a green PR unrecorded).

## Running and recording
Checks: install (derive per ecosystem, no cached command), lint, typecheck, test, each entry of `tests`. Use Bash
`timeout: 600000`; over 10 minutes → skip locally and rely on CI. Record every outcome, passes included:
```bash
curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" "$SHIPWRIGHT_TASK_STORE_URL/verification-checks" \
  -d '{"taskId":"{id}","repo":"'"$GH_REPO"'","checkName":"{checkName}","status":"{status}"}' >/dev/null 2>&1 || echo "⚠ POST failed — continuing"
```
`status` ∈ ran_passed, ran_failed, skipped, timed_out. `reasonCategory` only with skipped/timed_out: check_timeout,
install_timeout, resource_limit, missing_tool, missing_secret, missing_dependency, not_configured, learned_skip
(also takes `learnedFromCategory`). Failures caused by the environment (not the code) are `skipped` with the matching
category; if unsure, `ran_failed`.

## Learned skip
`GET /verification-checks?repo=$GH_REPO&checkName={name}&limit=2` (newest first). Both skipped/timed_out → skip locally,
record `skipped` + `learned_skip` + `learnedFromCategory` from the newest row.

## Scoped lint
If `lintScoped` is cached, use it: substitute `{base}`/`{head}` with `main`/`HEAD`, or `{changed files}` with
`git diff --name-only main...HEAD` filtered to linter extensions and existing paths. Empty list → skip lint and record
`skipped`/`not_configured`. Absent → full lint. Report `Lint: scoped (...)` or `Lint: full (...)`.

## Coverage
Run changed packages with coverage; report a table; threshold from planning Project Metadata (default 90%). Below
threshold → warn and proceed. Record `coverage_before` (null if unavailable), `coverage_after` (lowest package),
`coverage_delta`. Never silently skip measurement.
