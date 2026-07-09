---
name: error-scan
description: Scan Sentry for new/regressed unresolved issues, dynamically map them to repos. Report only — no code changes.
---

# Error Scan

Query Sentry for currently-unresolved issues across the org, diff them against a local
ledger to find what's **new** or **regressed** since the last run, dynamically derive which
checked-out repo each issue's `service` tag belongs to, and write a structured report. This
skill makes **no code changes** — it reads and reports only. Use `/error-fix` to act on the
findings.

This skill hardcodes Sentry as the backend (no provider abstraction) — see
`planning/error-patrol/PLAN.md` for the rationale. Support for other error-reporting
backends is explicitly out of scope.

---

## Setup: Parse Arguments

Before starting, check if any flags were passed:

- `--summary` — print counts to stdout; skip writing `error-report.md`
- `--dry-run` — run the full scan (Sentry API calls, service→repo derivation, diffing) but
  skip writing `error-report.md` **and** skip updating `state/error-patrol-ledger.json`.
  Print everything that would have been written to stdout instead. Use this to validate the
  skill end-to-end without mutating any state.

---

## Step 0: Preconditions

1. Confirm `SENTRY_ORG` and `SENTRY_AUTH_TOKEN` are set in the environment (`echo
   "org=$SENTRY_ORG token_set=$([ -n "$SENTRY_AUTH_TOKEN" ] && echo yes || echo no)"`). If
   either is unset or empty, print:
   ```
   error-scan requires SENTRY_ORG and SENTRY_AUTH_TOKEN to be set in the environment. Skipping scan.
   ```
   and stop. Do not write a report or touch the ledger.
2. Confirm `SHIPWRIGHT_REPO_DIR` is set (fall back to `$HOME/src` per the plugin default —
   see `docs/configuration.md`). This is the directory containing whatever repo checkouts
   the invoking agent happens to have — **never assume specific repo names live here.**
3. All Sentry API calls in the steps below use:
   ```bash
   curl -sS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" "https://sentry.io/api/0/..."
   ```
   Never print `$SENTRY_AUTH_TOKEN` itself, never write it to any file, and never echo the
   literal value of `$SENTRY_ORG` into a comment or log line that could get pasted somewhere
   persistent — always reference these as their env var names in output and in this file.

---

## Step 1: Enumerate Sentry Projects (Dynamic — No Hardcoded Project ID)

1. Call:
   ```bash
   curl -sS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
     "https://sentry.io/api/0/organizations/$SENTRY_ORG/projects/"
   ```
2. This returns a JSON array of project objects. Extract each project's `slug` field (e.g.
   via `jq -r '.[].slug'`). This is a paginated endpoint — Sentry returns a `Link` response
   header with `rel="next"` / `results="true|false"`; follow pagination (via the `cursor`
   query param from the `Link` header) until `results="false"` to get the full project list.
3. Record the full list of project slugs. This list is **derived at runtime** — do not
   assume any particular project exists or hardcode a slug anywhere in this file or in your
   working notes for this run.
4. If the projects list is empty, print `No Sentry projects found for org $SENTRY_ORG.` and
   stop (nothing to scan).

---

## Step 2: Enumerate Distinct `service` Tag Values (Dynamic — No Hardcoded Service List)

For each project slug from Step 1, call the tag-values endpoint to discover which `service`
tag values are currently reporting:

```bash
curl -sS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  "https://sentry.io/api/0/organizations/$SENTRY_ORG/$PROJECT_SLUG/tags/service/values/"
```

1. This returns a JSON array of tag-value objects; extract each `value` field (e.g. via `jq
   -r '.[].value'`). Follow pagination the same way as Step 1 if present.
2. If a project has no `service` tag at all (404 or empty array), that's a valid result —
   just means no events on that project carry a `service` tag. Move to the next project.
3. Union the `service` values across all projects into one deduplicated set — this is the
   full list of "observed service tags" for this run. Do not hardcode any service name; this
   set is entirely derived from the API responses above.
4. If the unioned set is empty across every project, print `No service tag values found
   across any project.` and stop (nothing to map or diff).

---

## Step 3: Derive the Service → Repo Mapping

This mapping tells a downstream skill (`error-fix`) which repo checkout corresponds to each
service tag, so it knows where to look for the code that raised an issue. Getting this wrong
sends a future agent session into the wrong source tree, so this step is deliberately
conservative: **when in doubt, mark `unmapped` — never guess.**

**Do not hardcode any repo name anywhere in this step's logic.** The set of repos is
whatever happens to exist under `$SHIPWRIGHT_REPO_DIR` on this run — treat it as fully
dynamic, the same way the Sentry projects and service tags are dynamic.

1. List the repos currently checked out under `$SHIPWRIGHT_REPO_DIR`:
   ```bash
   find "$SHIPWRIGHT_REPO_DIR" -mindepth 1 -maxdepth 1 -type d
   ```
   Each top-level directory here is a candidate repo. If `$SHIPWRIGHT_REPO_DIR` doesn't
   exist or is empty, treat every service tag from Step 2 as unmapped (there's nothing to
   grep) and continue — this is not a fatal error, just an empty mapping.

2. For each service tag value `S` from Step 2, and for each candidate repo directory `R`
   from step 1, grep `R` for the literal quoted string that would appear in a Sentry init
   call site, e.g. `"S"` or `'S'` (grep for the tag value as an exact quoted literal, not a
   substring match — a service value of `admin` should not match a file merely containing
   the word "administrator"). Use something like:
   ```bash
   grep -rn --include='*.ts' --include='*.js' --include='*.py' --include='*.go' --include='*.rb' \
     -e "\"$S\"" -e "'$S'" "$R"
   ```
   (adjust the `--include` extensions to whatever source languages are actually present in
   `R` — don't assume TypeScript specifically).

3. For every match, inspect a small window of context around the matched line (a few lines
   before/after — `grep -B3 -A1` or read the surrounding lines with the Read tool). Treat a
   match as a **confident hit** only if that context also contains something that looks like
   a Sentry init/config call site: the word `sentry` or `Sentry` **and** a `service` key
   (e.g. `service:` or `service =` or `service:"..."`) appearing near the matched literal.
   A bare string match with no nearby "sentry"/"service" signal is **not** confident — it's
   just an incidental match and must be discarded, not counted as a hit for that repo.

4. After checking every candidate repo for service tag `S`, classify the result:
   - **Exactly one repo has ≥1 confident hit** → map `S → that repo's directory name`.
     Record it as `mapped`.
   - **Zero repos have a confident hit** → `unmapped` (reason: `"no confident match"`).
   - **More than one repo has a confident hit** → `unmapped` (reason: `"ambiguous — matched
     in N repos"`, listing which repos matched). Do not pick one arbitrarily.
   - A confident-looking match that doesn't clearly belong to init/config code (e.g. it's in
     a test fixture, a comment, or generated/vendored code like `node_modules`,
     `dist`, `build`, `vendor`) does not count — exclude these paths from consideration
     before grepping if practical (e.g. add `--exclude-dir=node_modules
     --exclude-dir=dist --exclude-dir=vendor` to the grep).

5. Build the mapping as a simple object, e.g.:
   ```json
   {
     "<observed service tag A>": { "status": "mapped", "repo": "<matched repo dir name>", "matchedAt": "<path/to/file>:<line>" },
     "<observed service tag B>": { "status": "unmapped", "reason": "no confident match" }
   }
   ```
   (the keys and values above are placeholders illustrating the shape only — do not copy any
   of them as literal defaults; every entry must come from this run's actual grep results
   against the actual service tags and repos discovered in Steps 1-3.)

6. **This mapping is re-derived from scratch every run.** Never read a previously-persisted
   mapping from the ledger and trust it as-is — Step 6 persists this run's freshly-derived
   map for human visibility only, not as an input to this step.

---

## Step 4: Fetch Currently-Unresolved Issues

For each project slug from Step 1, fetch unresolved issues:

```bash
curl -sS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  "https://sentry.io/api/0/organizations/$SENTRY_ORG/issues/?query=is:unresolved&project=$PROJECT_ID"
```

Notes on this endpoint:
- The org-level issues endpoint takes a numeric `project` id (not slug) as a filter, or can
  be queried without a `project` filter to get issues across every project the token can
  see in one call — prefer the no-`project`-filter form (`.../organizations/$SENTRY_ORG/issues/?query=is:unresolved`)
  if it returns results across all projects in this Sentry instance; fall back to per-project
  calls (resolving each project's numeric `id` from the Step 1 response) only if the
  org-wide call appears scoped to a single default project.
- Follow pagination via the `Link` header / `cursor` param as in Step 1, so large result sets
  aren't silently truncated.
- For each issue, record at minimum: `id`, `shortId`, `title`, `culprit`, `permalink`,
  `status` (should be `unresolved` given the query filter), `count` (total event count),
  `userCount`, `firstSeen`, `lastSeen`, and the project's `slug`.
- For each issue, determine its `service` by reading the issue's `service` tag if present in
  the list payload; if not present in the list response, fetch
  `https://sentry.io/api/0/organizations/$SENTRY_ORG/issues/$ISSUE_ID/tags/service/` for that
  issue to resolve it. If an issue has no `service` tag at all, record its service as `null`
  (it will show up in the report as unmapped by definition — there's nothing to map).

---

## Step 5: Diff Against the Ledger

The ledger lives at `state/error-patrol-ledger.json` — **one level up from the repo
checkout, in agent workspace state, not tracked inside this repo** (same tier as
`state/entropy-patrol-last-run.json`; see that file for an example of this state tier's
location convention). Resolve its path relative to the repo root the same way
`state/entropy-patrol-last-run.json` sits relative to `repos/<repo>` — i.e. it is a sibling
of the repo checkouts, not a path inside the invoking repo's working tree.

1. If `state/error-patrol-ledger.json` does not exist yet, treat the ledger as empty
   (`{"issues": {}, "lastRun": null, "serviceRepoMap": {}}`) — this is a normal first run,
   not an error.
2. If it exists, read and parse it. Expected shape:
   ```json
   {
     "lastRun": "<ISO8601 timestamp of previous run>",
     "issues": {
       "<sentry_issue_id>": {
         "status": "unresolved | resolved | ignored",
         "count": <last-seen event count as of previous run>,
         "lastSeen": "<ISO8601>"
       }
     },
     "serviceRepoMap": { "<service>": { "status": "mapped|unmapped", "repo": "...", ... } }
   }
   ```
3. For each unresolved issue fetched in Step 4, classify it against the ledger's `issues`
   entry for that issue's `id`:
   - **New**: no entry exists for this issue `id` in the ledger at all.
   - **Regressed**: an entry exists, and *either* (a) the ledger's recorded `status` for
     that issue was `resolved` or `ignored` (i.e. it was not unresolved last run, and is
     unresolved now), *or* (b) the ledger's recorded `status` was already `unresolved` but
     the current `count` is greater than the ledger's recorded `count` (i.e. it kept
     firing — more events accumulated since last run). Document this precisely in the
     report so a human reviewing it understands why an issue was flagged regressed.
   - **Unchanged**: an entry exists, status was already `unresolved`, and current `count`
     is not greater than the ledger's recorded `count`. Unchanged issues are **not** included
     in the report body (only in the summary counts, if you choose to show a total).
4. Issues that exist in the ledger as `unresolved` but no longer appear in this run's
   unresolved fetch (Step 4) have presumably been resolved/ignored since the last run —
   note this for the ledger update in Step 6, but they do not need their own report section
   (that's `error-resolve`'s concern, not this skill's).

---

## Step 6: Write the Report

If `--summary` or `--dry-run` was passed, skip writing the file — for `--dry-run`, print the
exact content that would have been written instead; for `--summary`, print only the counts
table from below.

Write `error-report.md` to the project root (overwrite if it exists — same convention as
`entropy-report.md`). Format:

```markdown
# Error Report

**Generated:** {YYYY-MM-DD HH:MM} {timezone}
**Org:** $SENTRY_ORG (read from env — value not repeated literally in this file)
**Projects scanned:** {count}
**Service tags observed:** {count}

## Summary

| | Count |
|---|---|
| New issues | N |
| Regressed issues | N |
| Unchanged (not shown below) | N |
| Unmapped service tags | N |

---

## New Issues

{If none: "No new issues since last run."}

{For each new issue, as a checkbox:}
- [ ] `{shortId}` — {title} _{service tag, or "unmapped" if no confident repo match}_
  - Project: {project slug}
  - Repo: {mapped repo dir name, or **UNMAPPED** with the reason from Step 3}
  - Events: {count} · Users affected: {userCount}
  - First seen: {firstSeen} · Last seen: {lastSeen}
  - Link: {permalink}

---

## Regressed Issues

{If none: "No regressed issues since last run."}

{For each regressed issue, as a checkbox:}
- [ ] `{shortId}` — {title} _{service tag, or "unmapped"}_
  - Project: {project slug}
  - Repo: {mapped repo dir name, or **UNMAPPED** with the reason}
  - Why flagged: {"was resolved/ignored, now unresolved" | "event count grew from {old} to {new}"}
  - Events: {count} · Users affected: {userCount}
  - Last seen: {lastSeen}
  - Link: {permalink}

---

## Service → Repo Mapping (this run)

| Service tag | Status | Repo | Detail |
|---|---|---|---|
| {service} | mapped | {repo dir name} | matched at `{file:line}` |
| {service} | **unmapped** | — | {reason, e.g. "no confident match" or "ambiguous — matched in N repos"} |

_Any issue whose service tag is unmapped above is flagged **UNMAPPED** in its own entry too — `/error-fix` should treat these as needing manual repo identification, never a guessed repo._

---
_Run `/error-fix` to classify these issues and queue task-store tasks._
```

Rules:
- New issues and regressed issues are each sorted by `count` descending (highest event
  volume first) within their section.
- Unchanged issues are not listed individually — only reflected in the summary count.
- Every issue entry always states its repo mapping status explicitly, even when mapped —
  this makes it easy to spot-check the derivation without re-running the scan.

---

## Step 7: Persist the Derived Map + Update the Ledger

Skip this entire step if `--dry-run` was passed (dry runs must not mutate any state).
`--summary` alone does **not** skip this step — summary mode only affects report output, not
ledger persistence, since keeping the ledger current is what makes the *next* run's diff
correct.

1. Build the new ledger content:
   ```json
   {
     "lastRun": "<current UTC ISO-8601>",
     "issues": {
       "<sentry_issue_id>": {
         "status": "unresolved",
         "count": <current event count>,
         "lastSeen": "<ISO8601 from the issue payload>"
       }
       // one entry per issue fetched in Step 4 (all currently-unresolved issues, not just new/regressed ones)
     },
     "serviceRepoMap": {
       "<service tag>": { "status": "mapped", "repo": "<repo dir name>", "matchedAt": "<file:line>" }
       // or: { "status": "unmapped", "reason": "<reason from Step 3>" }
       // one entry per service tag observed in Step 2, from this run's fresh derivation
     }
   }
   ```
2. For any issue present in the *previous* ledger's `issues` map but absent from this run's
   unresolved fetch (Step 4), you may either drop it or retain it with `"status": "resolved"`
   — retaining it lets `error-resolve` observe the transition; prefer retaining with
   `"status": "resolved"` over dropping, since dropping loses the "this used to be
   unresolved" signal for no benefit.
3. Overwrite `state/error-patrol-ledger.json` with this new content (this is a full
   replace, not an append — unlike `entropy-scan`'s quality log, which is append-only, this
   ledger is a current-state snapshot).
4. Print: `Ledger updated: state/error-patrol-ledger.json`

**Important:** `serviceRepoMap` in the ledger is written **every run** from this run's fresh
Step 3 derivation — it is overwritten, never merged with the previous run's map, and it is
never read back in as an input to Step 3. Its only purpose is letting a human (or
`error-fix`) see what the last run inferred, without re-running the grep themselves.

---

## Step 8: Print Summary

Whether or not `--summary` was passed, always print a summary to stdout after the scan:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ERROR SCAN COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Projects scanned:        {N}
  Service tags observed:   {N}
  Services mapped:         {N}
  Services unmapped:       {N}

  NEW        {N} issues
  REGRESSED  {N} issues
  ─────────────────────
  Unchanged (not reported): {N}

{If any new/regressed issues exist:}
  Run /error-fix to classify these issues and queue task-store tasks.

{If zero new/regressed issues:}
  ✓ No new or regressed issues since last run.

{If --dry-run: "Dry run — no files written."}
{Else if --summary: "Summary only — error-report.md not written; ledger still updated."}
{Else: "Report written to: error-report.md"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Constraints (Do Not Violate)

- **No code changes.** This skill reads and reports only. The only files it writes are
  `error-report.md` (project root) and `state/error-patrol-ledger.json` (agent workspace
  state, one level up from repo checkouts) — and neither is written in `--dry-run` mode.
- **No git operations.** Do not commit, branch, or stage anything.
- **No PR creation.** `error-scan` never creates PRs or tasks — queueing issues as
  task-store tasks belongs to `/error-fix`.
- **Read-only network calls.** Only `GET` requests against the Sentry API. Never call an
  issue-mutating endpoint (resolve/ignore/delete) from this skill — that's `/error-resolve`'s
  job.
- **No hardcoded org, project, service, or repo names.** `$SENTRY_ORG` is read from the
  environment at runtime and never written literally into this file, into `error-report.md`,
  or into the ledger. Sentry projects and `service` tag values are always enumerated via the
  API. Repos are always enumerated by listing `$SHIPWRIGHT_REPO_DIR` at runtime — never
  assume or name a specific repo directory in this skill's logic.
- **Never log or persist `$SENTRY_AUTH_TOKEN`.** Not in the report, not in the ledger, not
  in stdout output.
- **Unmapped over guessed.** A service tag with zero confident repo matches, or matches in
  more than one repo, is always reported as `unmapped` — never resolved to a "best guess"
  repo. A wrong mapping here would send `/error-fix` to edit the wrong codebase.
- **The service→repo map is re-derived every run, never trusted from cache.** The map
  persisted into the ledger is for human/`error-fix` visibility only — it is not read back
  in as an input to a future run's Step 3.
- **One scan, one report.** Each run fully overwrites `error-report.md`. Previous results are
  not preserved (the ledger, not old reports, is the historical record).
- **Ledger is a snapshot, not a log.** Unlike `entropy-scan`'s append-only quality log,
  `state/error-patrol-ledger.json` is fully overwritten each run with current state.
- **`--dry-run` mutates nothing.** No report write, no ledger write — everything that would
  be written is printed to stdout instead.
- **`--summary` skips only the report file**, not the ledger update — the ledger must stay
  current so the next run's diff is correct regardless of which flag was used.
