---
name: error-scan
description: Scan Sentry (required --repo) for new/regressed unresolved issues whose project maps to that repo. Records PatrolFindings in the task store; no repo files, no code changes.
---

# Error Scan

Query Sentry for currently-unresolved issues, keep only the ones whose Sentry project maps to
the **one repo named by `--repo`**, diff them against that repo's `PatrolFinding`s in the task
store to find what is **new** or **regressed**, and record the findings plus one run. All finding
detail lives in the store and the scan-to-fix hand-off is the store; nothing is written to any
repo path. This skill makes **no code changes**. Use `/error-fix` to act on the findings.

This skill hardcodes Sentry as the backend (no provider abstraction). Other backends are out of
scope.

Issue tracking lives in `PatrolFinding` (fingerprint = the Sentry issue id). The Sentry
project-to-repo mapping lives in the run's `machineState` as `projectRepoMap`
(`{ "<project slug>": "org/repo" | null }`).

---

## Setup: Parse Arguments

- `--repo org/repo` — **required**. If missing or not `org/repo`, print and stop:
  ```
  Usage: /error-scan --repo org/repo [--cron ID] [--summary] [--dry-run]
  Error: --repo is required.
  ```
- `--cron ID` — the system-cron id the scheduler passes (default `error-patrol`); used as
  `CRON_ID` for the recorded run and findings.
- `--summary` — print counts only
- `--dry-run` — run the full scan and diff but record nothing; print what would be recorded

Set `REPO` to the `--repo` value. `cd` into the repo's local clone before Step 3.

---

## Step 0: Preconditions

1. Confirm `SENTRY_ORG` and `SENTRY_AUTH_TOKEN` are set (`echo "org=$SENTRY_ORG
   token_set=$([ -n "$SENTRY_AUTH_TOKEN" ] && echo yes || echo no)"`). If either is unset or
   empty, print:
   ```
   error-scan requires SENTRY_ORG and SENTRY_AUTH_TOKEN to be set in the environment. Skipping scan.
   ```
   and stop. Record nothing.
2. Confirm `SHIPWRIGHT_TASK_STORE_URL` and `SHIPWRIGHT_TASK_STORE_TOKEN` are set; otherwise
   invoke `/shipwright:task-store` for setup and stop.
3. Never print `$SENTRY_AUTH_TOKEN`, never write it to any file, and never echo the literal
   value of `$SENTRY_ORG` into persistent output — reference both by env var name.

---

## Step 1: Load Prior State

Read-only (also runs in `--dry-run`); this is also the one-time legacy import (Step 7):

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/cron-run-recorder.ts" prior --cron "$CRON_ID" --repo "$REPO" \
  --legacy-shape error-patrol-ledger
```

It prints `{latest, findings, imported}`. `findings` are this repo's PatrolFindings (the prior
issue set). `latest.machineState.projectRepoMap` (or, on the first run,
`imported.machineState.serviceRepoMap`) seeds the project-to-repo mapping as a hint only; Step 3
re-derives it.

---

## Step 2: Enumerate Sentry Projects and Service Tags

1. `GET https://sentry.io/api/0/organizations/$SENTRY_ORG/projects/` with
   `Authorization: Bearer $SENTRY_AUTH_TOKEN`; follow the `Link` header (`rel="next"`,
   `results="true"`) via `cursor` until exhausted. Record each project `slug`. Derived at
   runtime; never hardcode a slug. If empty, print `No Sentry projects found for org
   $SENTRY_ORG.` and stop.
2. For each slug, `GET /api/0/projects/$SENTRY_ORG/$SLUG/tags/service/values/` and collect the
   `value`s (404 or empty is valid: that project has no `service` tag).

---

## Step 3: Derive the Project → Repo Mapping (this repo only)

Getting this wrong files a fix against the wrong codebase, so **when in doubt, leave the project
unmapped — never guess.** Only the repo named by `--repo` (the current checkout) is searched;
no other repo checkout is listed or read.

For each project slug and each of its service tag values `S`, grep this checkout for the exact
quoted literal (`"S"` or `'S'`; exclude `node_modules`, `dist`, `build`, `vendor`):

```bash
grep -rn --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=vendor \
  -e "\"$S\"" -e "'$S'" .
```

A match is a **confident hit** only when nearby lines (a few before/after) also contain
`sentry`/`Sentry` **and** a `service` key. A bare match is incidental and discarded. Then:

- ≥1 confident hit for any of the project's service tags → `projectRepoMap[slug] = REPO`.
- No confident hit → `projectRepoMap[slug] = null` (unmapped), unless the Step 1 seed already
  maps it to a different repo, in which case keep that value.
- Projects with no `service` tag at all → `null`.

The map is re-derived every run; the stored one is never trusted as an input beyond the hint.

---

## Step 4: Fetch, Filter, Diff

Save the Step 3 map and Step 1 `findings` array to temp files outside the repo
(`TMP="$(mktemp -d)"`), then run the shared script, which fetches the unresolved issues
(paginated), keeps only issues whose project maps to `REPO`, and diffs them against the prior
findings:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/error-patrol/cli.ts" --repo "$REPO" \
  --map "$TMP/map.json" --prior "$TMP/prior.json" > "$TMP/result.json"
```

The filter is `scripts/error-patrol/repo-filter.ts` (covered by
`repo-filter.integration.test.ts` on recorded Sentry fixtures). Its result:

- **New**: no PatrolFinding with that fingerprint (the Sentry issue id).
- **Regressed**: one exists and *either* its status was not `open` (resolved/suppressed, now
  unresolved again) *or* it was `open` and `detail.count` grew.
- **Unchanged**: `open` and the count has not grown. Summary counts only.
- **Resolved**: stored `open` but absent from this run. Re-sent with `status: "resolved"` so a
  later reappearance is detected as a regression.
- **Unmapped**: issues whose project maps to no repo. They are counted in `metrics.unmapped`,
  produce **no finding and no task**, and are never named in recorded output. Issues mapped to
  a different repo are counted in `metrics.other_repo` and also produce nothing.

Each finding is `{fingerprint: <sentry issue id>, status, detail: {shortId, title, culprit,
permalink, project, repo, count, userCount, firstSeen, lastSeen}}`; `/error-fix` orders by
`detail.count`.

---

## Step 5: Record the Run

Skip this step if `--dry-run` was passed (dry runs record nothing). `--summary` alone does
**not** skip it.

```bash
bun "${CLAUDE_PLUGIN_ROOT}/scripts/cron-run-recorder.ts" record --cron "$CRON_ID" --repo "$REPO" \
  --commit "$(git rev-parse HEAD)" --result "$TMP/result.json" --legacy-shape error-patrol-ledger
```

The result file already holds `{outcome, metrics, machineState: {projectRepoMap}, findings}`
(`outcome` is `no_op` when nothing was new, regressed or resolved). Delete `$TMP` afterwards.
Findings upsert by fingerprint, so a re-run is idempotent.

---

## Step 6: Print Summary

Cron runs post this to a channel where nobody can reply in the moment, so **cap the final
response at 3-5 lines**: a status line, the counts, and a hint. Detail stays in the store.

```
ERROR SCAN COMPLETE — {org/repo}: {N} new, {M} regressed ({U} unchanged, not reported)
Unmapped: {N} · Other repo: {N}
{If new/regressed: "Next: /error-fix --repo {org/repo} to queue tasks."}  {If zero: "✓ No new or regressed issues."}
{If --dry-run: "Dry run — nothing recorded."}  {Else: "Recorded to the task store."}
```

---

## Step 7: One-Time Legacy Import (the only place the legacy ledger is touched)

The `--legacy-shape error-patrol-ledger` flag in Steps 1 and 5 is the one-time import (PCR-2.1).
When the store has no run for this cron+repo yet, the recorder reads the agent-local
`state/error-patrol-ledger.json`, keeps only entries for this repo (other repos' entries are
ignored), posts them as PatrolFindings and the run's `machineState`, and deletes the file only
after both posts succeed. This skill never reads or writes that file directly and never creates it.

---

## Constraints (Do Not Violate)

- **`--repo` is required.** No fallback to the current directory or a repo list, and no
  multi-repo scan.
- **No code changes, no repo writes.** No report file, nothing under the project tree. The only
  local files are the transient temp files in Step 4/5, deleted after the run.
- **Findings live in the store.** The hand-off to `/error-fix` is the store, not a file.
- **No git operations** (reading `git rev-parse HEAD` is fine). No PR or task creation: queueing
  belongs to `/error-fix`.
- **Read-only Sentry.** Only `GET` requests; resolving belongs to `/error-resolve`.
- **No hardcoded org, project, service or repo names.**
- **Never log or persist `$SENTRY_AUTH_TOKEN`.**
- **Unmapped over guessed.** An unmapped project's issues are counted, never assigned to a
  repo and never given a task.
- **`--dry-run` records nothing.**
