---
name: environments-scan
description: "Scan one repo for environment readiness gaps (lockfile, pinned tool versions, preview environment, structured logging, error tracking, tracing/metrics, staged or canary deploy) and write docs/patrols/environments.md (docs PR on material change). Requires --repo org/repo. Report only — no code changes."
argument-hint: "--repo org/repo [--summary] [--dry-run]"
---

# Environments Scan

Scan **one repo** for the gaps behind the readiness catalogue's `environments` checks
([docs/readiness.md](../../../../docs/readiness.md)), write the open items to
`docs/patrols/environments.md`, and hand the structured findings to `/environments-fix`. This
skill makes **no code changes** to the scanned code.

Run by the `environments` system cron, one task per repo, as
`/shipwright:environments-scan --repo {repo}` then `/shipwright:environments-fix --repo {repo}`
(the system-cron contract: [docs/task-store.md](../../../../docs/task-store.md), "System-cron contract").

## Setup: Parse Arguments

`--repo org/repo` is **required**. If it is missing, print the following and stop without
scanning `repos/` or doing any other work:

```
Usage: /shipwright:environments-scan --repo org/repo [--summary] [--dry-run]
```

- `--summary` — print the summary only; skip the docs file and the handoff
- `--dry-run` — run the full scan, but write no commit, no PR and no run record

## Step 0: Resolve the repo and worktree

Find the repo's clone by matching each `repos/*/` `origin` remote against `org/repo` (clone it
if none matches) and work in a worktree, never in the clone itself. Follow the docs-PR flow of
`/shipwright:entropy-scan` Step 0 with the branch prefix `docs/environments-patrol-`
(open-PR supersession check first; reuse an earlier-day PR's branch). Note `git rev-parse HEAD`.

## Step 1: Read the prior run

```bash
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/cron-run-recorder.ts" prior \
  --cron environments --repo {org}/{repo}
```

`latest` is used only to word the summary, never to skip the scan. If the recorder errors, log
it and continue with no prior state.

## Step 2: Fetch active tasks (dedup input)

List this repo's active tasks (`status=pending`, `in_progress`, `blocked`; `limit=1000`;
follow `nextCursor` until null) and write `[{id, status}]` to `/tmp/environments-active.json`.

## Step 3: Detect

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/environments-scan.ts" scan --repo {org}/{repo} \
  --root . --active-tasks /tmp/environments-active.json --out /tmp/environments-result.json
```

Detection is deterministic file inspection (no network), reusing the toolchain detection's
lockfile and manifest recognition (`references/toolchain-patterns.md`). The output carries
`findings`, the candidate `doc`, `materiallyChanged`, `violations`, planned `tasks` and
`metrics`. The checks are:

- **lockfile** — a manifest with no committed lockfile (route: auto)
- **tool-versions** — no tool-version file, container or devcontainer (route: auto)
- **preview-environment** — needs both a bring-up entry point (compose file, Taskfile/Makefile/
  package script target, Tilt or Skaffold) **and** a CI job that runs tests against it. Missing
  either one is reported (route: plan)
- **structured-logging** — no structured logging library (route: review)
- **error-tracking** — no error-tracking SDK; the finding lists provider choices for a human
  to pick (route: review)
- **tracing-metrics** — no OpenTelemetry, Prometheus or StatsD client (route: plan)
- **staged-canary** — no staged or canary deploy (route: plan)

Write the findings and planned tasks to `.environments-patrol/findings.json` in the worktree
(local scratch for `/environments-fix`, never committed).

## Step 4: Write docs/patrols/environments.md

Skip under `--summary`. Write `doc` from Step 3 to a temp file and validate it:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/check-patrol-docs.ts" /tmp/environments-candidate.md docs/patrols/environments.md
```

The doc is current open items only: at most 150 lines, no count tables, no run history, no
resolved items, no timestamps. All numbers go in the run record.

- **Not `materiallyChanged`:** leave the file untouched, commit nothing, open no PR.
- **`materiallyChanged`, not `--dry-run`:** copy the candidate over the file, commit
  `docs: environments patrol ({YYYYMMDD})`, push, and open (or update) the docs PR with the
  `shipwright` label, as in `/shipwright:entropy-scan` Step 4.3.
- **`--dry-run`:** print whether a PR would open; write nothing.

On failure, record a failed run (below) before stopping.

## Step 5: Summary

Cap the output at 3-5 lines: `ENVIRONMENTS SCAN COMPLETE — {org/repo}: {N} open items`, the
routes (`auto/review/plan`), and the docs PR url or `unchanged`. Next: `/environments-fix`.

## Run recording

`/environments-fix` records the single success run. This skill records only a **failed** run,
never under `--dry-run`:

```bash
echo '{"outcome": "failed", "metrics": {"error": 1}}' > /tmp/environments-result.json
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/cron-run-recorder.ts" record --cron environments \
  --repo {org}/{repo} --commit {sha} --result /tmp/environments-result.json
```

## Constraints (Do Not Violate)

- **`--repo` is required.** Never scan `repos/` as a list or infer the repo from the cwd.
- **No code changes** to the scanned code. The only repo file written is `docs/patrols/environments.md`, via the docs PR.
- **PR only on material change.** An unchanged repo opens no PR.
- **No task creation.** Routing findings into tasks belongs to `/environments-fix`.
- **No local state.** Prior state comes from the task store; `.environments-patrol/` is scratch and never committed.
