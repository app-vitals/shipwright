---
name: consolidation-fix
description: Read a repo's ready_to_propose consolidation patterns from the task store (PatrolFinding) and queue them as routed task-store tasks (auto, review or plan), one task per pattern, each carrying a strangler-fig (build -> coexist -> eliminate) execution plan. Requires --repo org/repo and consolidation-scan to have run first.
---

# Consolidation Fix

Read one repo's `ready_to_propose` patterns from the task store's `PatrolFinding`
ledger (written by `consolidation-scan`) and queue focused, human-reviewable tasks for
them. Each task proposes a canonical shape for one stabilized duplication pattern plus
a strangler-fig execution plan broken into small, separate PR-sized steps — never a
single sweeping diff. Findings are never turned into direct PRs; they always become
task-store tasks. Each is routed one of three ways (auto, review or plan — Step 7),
following the routing contract in `docs/task-store.md` ("Finding routing").

This is the `consolidation-scan` counterpart that mirrors `entropy-fix`'s
relationship to `entropy-scan` — same dedup mechanism, same task-store fields, same
queue-only contract. The two patrols (entropy and consolidation) remain fully
decoupled: this skill never promotes a consolidation finding into an entropy-scan
rule, and it never asks entropy-fix to do anything. That graduation/promotion
mechanism is explicitly out of scope.

**Prerequisites:** Run `/consolidation-scan --repo org/repo` first so the repo has
`ready_to_propose` findings in the store.

> **Task store setup:** This skill pushes findings to the Shipwright task store. If
> `SHIPWRIGHT_TASK_STORE_URL` or `SHIPWRIGHT_TASK_STORE_TOKEN` is missing, invoke
> `/shipwright:task-store` for setup instructions.

---

## Setup: Parse Arguments

`--repo org/repo` is **required**. If it is missing or not in `org/repo` form, print
this usage error and stop without reading or writing anything:

```
--repo is required.
Usage: /shipwright:consolidation-fix --repo org/repo [--dry-run] [--pattern fingerprint]
```

Derive `repo-slug` from it: the last path segment, lowercased — e.g.
`app-vitals/shipwright` → `shipwright`. It is used in task ids (Step 8).

Flags:

- `--dry-run` — print what tasks would be queued without querying the task store for
  dedup or writing any tasks (the run is not recorded either)
- `--pattern {fingerprint}` — queue only the candidate whose fingerprint matches
  (full or unambiguous prefix)

> **Note:** Queueing is the only mode. There is no PR mode and no `--queue` flag —
> every run queues tasks. `--dry-run` shows a preview and stops without touching the
> task store.

---

## Step 1: Load ready_to_propose Findings From the Store

1. Fetch the repo's promoted patterns from the `PatrolFinding` ledger. Follow
   `nextCursor` until it is `null` — never proceed with a partial page:
   ```bash
   curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/patrol-findings?cronId=consolidation-patrol&repo={url-encoded-repo}&status=ready_to_propose&limit=200" | jq .
   ```
2. If there are none, print:
   ```
   No ready_to_propose consolidation patterns for {repo}. Nothing to queue.
   Run /consolidation-scan --repo {repo} again in future weeks to let more candidates stabilize.
   ```
   Record the run (Step 10) with `outcome: no_op` and stop.

---

## Step 2: Filter to `ready_to_propose` Entries Only

1. Every finding returned by Step 1 is, by construction, already
   `status: ready_to_propose` — `consolidation-scan` only sets that status once the
   promotion gate is met, and `tracking` findings are never fetched. Do not
   re-derive or re-check `occurrence_count`/`consecutive_stable_runs` thresholds here.
2. If `--pattern` was passed, filter to only the finding whose `fingerprint`
   matches. If none matches, print: "No ready_to_propose entry with fingerprint
   `{pattern}`. Nothing to queue." and stop. If the prefix matches more than one
   finding — fingerprints are truncated hashes, so prefix collisions are possible —
   print all matching fingerprints and stop, asking the caller to disambiguate:
   ```
   Ambiguous --pattern `{pattern}` matches {N} entries:
     {fingerprint-1} — {pattern description}
     {fingerprint-2} — {pattern description}
     ...
   Re-run with a longer prefix to disambiguate.
   ```
3. For each remaining finding, extract from `detail` and the row: fingerprint,
   `description`, `files` (occurrence list, `file:line — note`), `proposed_shape`,
   `firstSeen`/`lastSeen`, and `history`.

---

## Step 3: Cross-Check consolidation-decisions.md (Once More Before Queueing)

Even though `consolidation-scan` already checks the decisions registry before
promoting a candidate to `ready_to_propose` (its Step 7), the registry can change
between when the finding was promoted and when this skill runs — a human may have
reviewed a prior `consolidation-fix` PR and added a new accepted-debt entry since.
Never trust the stored promotion decision as still current; re-check live.

See `references/decisions-registry.md` for the shared decisions-registry pattern this
mirrors.

1. Check for `.claude/shipwright/consolidation-decisions.md` in the project root.
2. **If it does not exist**, treat this as "no suppressions configured" — the same
   graceful no-op `consolidation-scan` uses. Print: "No consolidation-decisions.md
   found — no suppressions configured." and continue to Step 4 with an empty
   suppression list. This is expected and not an error.
3. **If it exists**, load and parse it the same generic, defensive way
   `consolidation-scan`'s Step 1 does: read each `###` entry for its **Pattern**,
   **Decision**, **Rationale**, and **Revisit** fields where present, but do not
   hardcode assumptions about the registry's exact heading/field layout beyond
   those four fields — skip any entry you can't confidently interpret rather than
   failing the whole load.
4. For each `ready_to_propose` entry from Step 2, compare its pattern description
   against every suppression entry's **Pattern** field. If a suppression clearly
   matches:
   - If the suppression's **Revisit** condition has been met (a stated date has
     passed, a stated occurrence/churn threshold has now been exceeded, or a stated
     triggering event has occurred), the candidate is no longer suppressed —
     continue queueing it normally.
   - Otherwise, **skip this candidate** — do not queue a task for it. Print:
     `Skipping {fingerprint} — accepted as debt per consolidation-decisions.md ("{pattern name}")`.
5. This is a judgment-based match, not exact string equality — read both
   descriptions and decide whether they describe the same duplication, the same
   comparison style Step 3 of `consolidation-scan` uses when surveying.
6. For each entry that survives the decisions-registry check above, also run it
   through the pre-filing verification checklist —
   `references/pre-filing-verification.md` (relative to the plugin root) — before it
   proceeds any further. The registry check above only re-verifies suppression
   status; it says nothing about whether the occurrence list itself is still
   accurate, since the finding is a snapshot that may already be stale by the time
   this skill runs. Treat `references/pre-filing-verification.md` as canonical for
   how to apply the checklist. Per its four checks:
   - For each occurrence (`file:line`) in the candidate's occurrence list, verify
     the file/line still exists and the duplication pattern is still actually
     present there (Checklist Items 1–2). If every occurrence has been resolved or
     no longer matches the described pattern, drop the candidate entirely — do not
     queue a task for it. Print: `Skipping {fingerprint} — stale, no remaining
     occurrences match the described pattern`. If only some occurrences are stale,
     drop those from the occurrence list and proceed with the remaining ones (the
     Step 6 execution plan and Step 8 task JSON are built from the surviving
     occurrences only).
   - Route candidates whose occurrences can't be confirmed by a literal check to
     review rather than assuming they're safe to drop (Checklist Item 3) — this feeds
     into the route choice in Step 7 (review).
   - Checklist Item 4 (task ID / branch collisions) is satisfied by this skill's
     own Step 5 dedup check; no separate action is needed here beyond noting the
     overlap.
   This runs once, here in Step 3, so both the `--dry-run` preview (Step 4) and the
   real queue path (Step 5 onward) operate on the same already-verified candidate
   set.

---

## Step 4: Dry-Run Output (if --dry-run)

If `--dry-run` was passed, print a preview and stop without querying or writing to
the task store:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONSOLIDATION FIX — DRY RUN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Would queue {N} tasks:

  1. consolidation-{fingerprint-or-slug}-{repo-slug}-{YYYY-Www}
     Pattern: {pattern description}
     Occurrences: {count} sites across {list of unique file paths}
     Canonical shape: {one-line summary of proposed canonical shape}
     Strangler-fig steps: {count} PR-sized steps (build -> coexist -> eliminate)
     Route: {auto|review|plan} (per Step 7)

  2. ...

No tasks written to task store.
Re-run without --dry-run to queue tasks.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Stop after printing.

---

## Step 5: Dedup Check Against the Task Store

This mirrors `entropy-fix`'s dedup mechanism (its Step 6q.1) exactly — same
queries, same filters, no new task-store schema or fields.

The `repo` value is the `--repo` argument (e.g. `app-vitals/shipwright`), used both
to scope the dedup queries below and, unchanged, as the task JSON's `repo` field in
Step 8. `repo-slug` was derived in Setup.

Run (URL-encode the repo, e.g. `app-vitals%2Fshipwright`). `GET /tasks`
defaults to `limit=50` and truncates silently unless the caller raises it — pass an
explicit high `limit=1000` on both queries:
```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?status=pending&repo={url-encoded-repo}&limit=1000" | jq .
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?status=in_progress&repo={url-encoded-repo}&limit=1000" | jq .
```

The `&repo=` filter scopes dedup to tasks for the repo currently being scanned —
without it, a pattern active for one repo would incorrectly block or interfere with
dedup for a different repo.

**Pagination guard — do not silently proceed with a partial result set.** `limit=1000`
covers the common case, but a repo can still have more than 1000 active tasks. After each call, check the response's `nextCursor`: if it is `null`, the page is complete. If it is a string,
the first `limit=1000` page did not cover every active task — re-run the same query with
`&cursor=<nextCursor>` (the opaque string from the previous response; never parse or build one)
and merge the `.tasks` arrays, repeating until `nextCursor` is `null`. Only treat the dedup
query as complete once every page has been fetched this way; never build the "already active"
set (below) from a page that fails this check.

Parse both `.tasks` arrays. From the combined results, collect tasks where:
- `source == "shipwright"`, OR
- `title` starts with `"Consolidation:"` (this skill's title-prefix, mirroring
  entropy-fix's `"Entropy fix:"` prefix)

Extract the fingerprint (or pattern slug) from existing tasks by parsing the `id`
field (format: `consolidation-{fingerprint-or-slug}-{repo-slug}-{YYYY-Www}`) or from
the `branch` field (format: `feat/consolidation-{fingerprint-or-slug}-...`). Build a
set of "already active" fingerprints/slugs.

For each `ready_to_propose` candidate: if its fingerprint (or slug) is in the
"already active" set, skip it. Print: `Skipping {fingerprint} — task already active`.

No new task-store schema is introduced anywhere in this skill — every field used in
Step 6's task JSON is a field the task store already supports for any other task
(`id`, `title`, `source`, `repo`, `branch`, `layer`, `kind`, `status`, `hitl`, `description`).

---

## Step 6: Build the Strangler-Fig Proposal Per Candidate

For each candidate that survives Steps 3 and 5, draft the canonical-shape proposal
and its execution plan before building the task JSON in Step 8.

1. **Canonical-shape proposal.** Start from the finding's `detail.proposed_shape`
   (written by `consolidation-scan`) and firm it up into a
   concrete interface/implementation sketch: what the single shared implementation
   looks like, where it should live (an existing shared module/service if one
   already fits, or a clearly-named new one), and its call signature.
2. **Strangler-fig execution plan.** Break the migration into small, separate
   PR-sized steps — never one sweeping diff that touches every call site at once.
   The three phases, in order:
   - **Build.** Land the canonical implementation in isolation — new code only, no
     call sites changed yet. This PR is low-risk because nothing depends on it yet.
   - **Coexist.** Migrate call sites one at a time (or in small batches), each as
     its own PR: point one occurrence at the canonical implementation while the old
     implementation(s) at the remaining occurrences stay in place. Both the
     migrated and not-yet-migrated call sites must keep passing the same tests
     throughout — this is the safety property that makes the migration
     interruptible and revertable at every step, matching the precedent set by
     AI-agent-driven migration playbooks (e.g. Devin's playbooks, Sourcegraph's
     Agentic Batch Changes): validate the approach on one instance first, then
     checkpoint each subsequent PR against this same plan before rolling out to the
     rest, rather than improvising a different approach partway through.
   - **Eliminate.** Once every occurrence has been migrated and validated, remove
     the old implementation(s) in a final small PR (a pure deletion — low risk since
     by that point nothing else references the old code). This step is covered by
     the task's single route (Step 7) like every other step; it does not get its own
     separate route.
   - Cap each step's estimated diff size in the task description so the executor
     (human or `dev-task`) doesn't bundle multiple call-site migrations into one PR.
     A one-line rule of thumb: **one call site (or a small batch of near-identical
     ones) per PR**, not "migrate everything in one branch."
3. Keep the full occurrence list from the finding attached to the plan — each step
   in the coexist phase should reference which specific occurrence(s) it covers, so
   a human reading the task later can tell which sites are done and which remain.

---

## Step 7: Route Each Finding (auto / review / plan)

Every finding is routed one of three ways, per the finding-routing contract in
`docs/task-store.md` ("Finding routing"). There is no numeric backstop beyond the
heuristic below — no rigid file-count or line-count threshold alone forces a route,
beyond the "~5 call sites" guidance stated explicitly here. Judge each candidate on
its own facts, at runtime, using the same reading-comparison approach
`consolidation-scan` uses to compare shapes.

The deciding question is size: **a single-PR fix routes to auto or review; a
strangler-fig plan spanning several PRs routes to plan.**

- **auto** — a single, clear canonical shape with **existing precedent elsewhere in
  the codebase** (it mirrors a pattern the codebase already uses successfully), no
  real ambiguity about which shape is "the" canonical one, and a small enough
  occurrence count that the whole migration is one PR-sized fix. Task:
  `kind: dev`, `status: pending`, `hitl: false`.
- **review** — the fix is still one PR but needs a human answer first: **multiple plausible
  canonical shapes** where reasonable engineers could disagree, occurrences
  that could not be confirmed by a literal check (pre-filing verification, Checklist
  Item 3), or a call-site list the executor should not touch without a go-ahead.
  Task: `kind: dev`, created `status: blocked` with `blockedReason` starting
  `needs-review:` and holding the specific question for the human. Never
  `hitl: true`; a human unblocks it via `POST /tasks/{id}/unblock` and agents then
  execute it.
- **plan** — the migration is bigger than one task: the strangler-fig plan spans
  several PRs (the usual case beyond roughly five call sites), crosses service or
  repo boundaries (e.g. `plugins/shipwright/` and `agent/`, where a shared
  abstraction needs a dependency or publishing surface that does not exist yet), or
  otherwise needs architectural sequencing. Task: `kind: prd`, `hitl: true`,
  description = a draft problem statement plus the finding and its strangler-fig
  plan. A human runs it through `/shipwright:prd` or `/shipwright:plan-session`,
  which produces the agent-executable PR tasks; the autonomous plan phase skips it
  because it is `hitl: true`.
- "~5 call sites" is a heuristic for judgment to weigh, not a hard cutoff (4 call
  sites spanning two services can still be **plan**, and 6 call sites of a trivially
  mechanical single-shape rename can still be one **auto** PR if every other factor
  points that way). No default lean either way.

The plan route is the only one that sets `hitl: true`; this skill has no credential
route.

---

## Step 8: Build Task JSON

For each remaining candidate, build a task object. Reuse the `repo` and `repo-slug`
values from Setup and Step 5. Common fields:

```json
{
  "id": "consolidation-{fingerprint-or-slug}-{repo-slug}-{YYYY-Www}",
  "title": "Consolidation: {pattern description}",
  "source": "consolidation-fix",
  "originKind": "cron",
  "originRef": "consolidation-patrol",
  "repo": "<the --repo value>",
  "branch": "feat/consolidation-{fingerprint-or-slug}-{short-description}",
  "layer": "Shared",
  "description": "<occurrence list + canonical-shape proposal + strangler-fig step plan — see below>"
}
```

Plus the fields of the chosen route (Step 7):

```json
{ "kind": "dev", "status": "pending", "hitl": false }
```
(auto)

```json
{ "kind": "dev", "status": "blocked", "hitl": false,
  "blockedReason": "needs-review: <the specific question for the human>" }
```
(review)

```json
{ "kind": "prd", "status": "pending", "hitl": true }
```
(plan — the sole `hitl: true` shape)

The `description` field must give the executor enough context
to execute the whole migration without re-reading the finding:

```
Consolidation patrol finding: {fingerprint} — {pattern description}

Occurrences ({count} total):
- {file_path}:{line_range} — {brief note on this instance}
{Include the full occurrence list from the finding. If there are more than 20, include the first 20 and append: "(+N more — re-run /consolidation-scan to see all)"}

Proposed canonical shape:
{the firmed-up canonical-shape proposal from Step 6.1}

Strangler-fig execution plan (separate PRs, do not bundle):
1. Build — {what the canonical implementation PR contains, where it lives}
2. Coexist — {step per call site or small batch, each its own PR; note both old and new must keep passing the same tests at every step}
   ...
N. Eliminate — {final PR removing the old implementation(s), once every occurrence is migrated}

Fingerprint: {fingerprint} | First seen: {firstSeen} | Last seen: {lastSeen} | Route: {auto|review|plan}
```

The `{repo-slug}` segment is the last path segment of the detected `repo` value
(from Setup), lowercased — e.g. `app-vitals/shipwright` → `shipwright`. It
namespaces the task ID per repo so the same pattern scanned in two different repos
in the same week never collides.

The `{YYYY-Www}` suffix in the task ID uses ISO week format, same convention as
`entropy-fix`. Compute from the current date:
- Year: 4-digit year
- `W`: literal `W`
- Week number: 2-digit zero-padded ISO week number (01–53)
- Example: `consolidation-a1b2c3d4-shipwright-2026-W29`

`fingerprint-or-slug`: prefer a short prefix of the finding's fingerprint hash (e.g.
first 8 hex chars) for uniqueness; `short-description`: lowercase, hyphens, max 5
words from the pattern description.

---

## Step 9: Write and Append

1. Write all task objects to `/tmp/consolidation-tasks-{unix-timestamp}.json` as a
   JSON array.
2. Run:
   ```bash
   curl -sf -X POST \
     -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     -H "Content-Type: application/json" \
     "$SHIPWRIGHT_TASK_STORE_URL/tasks/bulk" \
     --data-binary @/tmp/consolidation-tasks-{unix-timestamp}.json | jq .
   ```
3. Delete the temp file after appending.

---

## Step 10: Record the Run and Print Summary

Record exactly one run with the recorder (not under `--dry-run`). Write a result file
`{ "outcome": "ok" | "no_op", "metrics": { "auto": N, "review": N, "plan": N, "skipped": N, "suppressed": N } }`
(`no_op` when nothing was queued) and post it:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/cron-run-recorder.ts record \
  --cron consolidation-patrol --repo {org/repo} --commit {HEAD sha} \
  --result /tmp/consolidation-fix-result-{ts}.json
```

The `auto`, `review` and `plan` metrics count the three routes separately. Then print:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONSOLIDATION FIX — QUEUED — {org/repo}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  QUEUED     {N} tasks   ({A} auto, {R} review, {P} plan)
  SKIPPED    {N} candidates (already active)
  SUPPRESSED {N} candidates (accepted as debt per consolidation-decisions.md)

Tasks queued:
  consolidation-{fingerprint-or-slug}-{repo-slug}-{YYYY-Www} — {pattern description}  [route: {auto|review|plan}]
  ...

{If any skipped:}
Skipped (already active):
  {fingerprint} — task already in queue or in progress

{If any suppressed:}
Suppressed (accepted as debt):
  {fingerprint} — {consolidation-decisions.md entry name}

Auto tasks run through the normal dev loop; review tasks wait for a human to unblock
them; plan tasks wait for a human to run /shipwright:prd or /shipwright:plan-session.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Stop after printing — this is the sole final output.

---

## Error Handling

- **Task-store query fails** (dedup in Step 5): log the failure and stop. Do not
  queue tasks without a dedup pass, or you risk duplicate tasks for the same
  pattern.
- **Bulk append fails** (`/tasks/bulk` non-2xx): log the response body and stop. Do
  not retry blindly; re-running the skill is idempotent because the dedup check
  will skip already-queued patterns.
- **No ready_to_propose candidates**: handled in Step 1 — print the "nothing to
  queue" message, record a `no_op` run and stop.
- **Findings query fails** (Step 1): log the failure and stop; record the run with
  `outcome: failed` if the recorder is reachable.

---

## Constraints (Do Not Violate)

- **One task per stabilized pattern** — never bundle multiple `ready_to_propose`
  entries into one task.
- **Queue only, no PR creation** — this skill never opens PRs and never leaves the
  base branch. It only writes tasks to the task store; the actual fix lands later
  via the normal dev loop (auto/review) or a human-run `/shipwright:prd` (plan).
- **No code changes made directly by this skill.** It drafts a proposal and a plan
  in the task description; it does not implement any part of the migration itself.
- **No new task-store schema.** Every field in the task JSON (Step 8) is a field
  the task store already supports for any other task — `id`, `title`, `source`,
  `repo`, `branch`, `layer`, `kind`, `status`, `blockedReason`, `hitl`,
  `description`, `originKind`, `originRef`. This skill introduces no new fields.
- **Cross-check consolidation-decisions.md live, every run** — never trust that a
  `ready_to_propose` finding is still un-suppressed; a human may have
  added a new accepted-debt entry since the finding was promoted (Step 3).
- **This skill does not re-run consolidation-scan.** It only reads the findings the
  last scan stored; if they are stale, re-run `/consolidation-scan --repo ...`
  separately first — this skill never triggers that itself.
- **No graduation/promotion to entropy-scan.** Entropy patrol (`entropy-scan`/
  `entropy-fix`) and consolidation patrol (`consolidation-scan`/`consolidation-fix`)
  stay fully decoupled by explicit decision — this skill never writes an
  entropy-scan rule, principles.md entry, or any cross-system reference. If a
  consolidation pattern seems worth graduating into a named entropy rule someday,
  that requires a separate, deliberate decision outside this skill's scope.
- **No cascade** — only queue what is in the store's current `ready_to_propose`
  findings. Do not re-scan during a run.
- **`hitl: true` only on the plan route** — review tasks are created blocked with a
  `needs-review:` reason, auto tasks are plain pending dev tasks.
- **Findings are not edited here** — a queued task only means a fix is scheduled.
  `consolidation-scan` owns finding status; this skill never rewrites it.
- **`--repo org/repo` is required**; no agent-local state is read or written.
