---
name: consolidation-scan
description: "Discover emerging duplicate/similar code patterns in one repo via judgment-driven comparison, track them across runs in the task store's PatrolFinding ledger, and list only stabilized open patterns in docs/patrols/consolidation.md. Requires --repo org/repo. Report only — no code changes."
---

# Consolidation Scan

Survey the codebase for **emerging, unnamed** duplicate or near-duplicate logic —
the same responsibility implemented independently in two or more places — weight
candidates by how actively their files are being edited, and track them across
multiple weekly runs in the task store's `PatrolFinding` ledger before proposing anything. This skill makes
**no code changes** — it reads and reports only.

**Scope note — how this differs from `entropy-scan`:** `entropy-scan` is stateless
and deterministic — it checks a fixed set of *named* rules from `references/principles.md`,
each with an explicit `**Detection:**` instruction, and every run stands alone.
`consolidation-scan` is the opposite shape: there is no named rule to check against.
It relies on judgment — an LLM reading and comparing the *purpose and structure* of
code across files and services — to notice duplication that a deterministic checker
can't name in advance. Because a single pass of judgment-driven comparison is noisy
and prone to one-off false positives, this skill never proposes anything from a
single run: it persists what it finds as `PatrolFinding` rows and only
promotes a candidate once it has recurred, with a stable shape, across multiple runs
(Rule of Three — see Steps 6-7). Static clone-detection tools (jscpd, SonarQube CPD)
are explicitly not used here — they only catch textual/token clones; this skill's
job is to catch *semantic* duplication that shares no lines at all (e.g. three
independently-written retry-with-backoff implementations).

---

## Setup: Parse Arguments

`--repo org/repo` is **required**. This skill scans exactly one repo per run (the
`consolidation-patrol` system cron queues one task per repo). If `--repo` is missing
or not in `org/repo` form, print this usage error and stop without scanning:

```
--repo is required.
Usage: /shipwright:consolidation-scan --repo org/repo [--summary] [--dry-run]
```

Work in a worktree of that repo (never edit the `repos/` checkout directly) and run
the survey against it. Note the checked-out commit (`git rev-parse HEAD`) — it is
recorded with the run. The cron id used with the recorder below is
`consolidation-patrol`. See the system-cron contract in `docs/task-store.md`.

Flags:

- `--summary` — print counts to stdout; skip writing `docs/patrols/consolidation.md`
  (findings and the run record are still written)
- `--dry-run` — run the full scan (survey, churn-weighting, fingerprinting, counter
  updates) but write **nothing**: no findings upsert, no run record, no docs file, no
  PR. Print what would have been written instead. The legacy import is also skipped
  (the legacy file is left untouched).

---

## Step 1: Load the Decisions Registry (Suppressions)

See `references/decisions-registry.md` for the shared decisions-registry pattern this
mirrors — the generic entry schema, ownership, and consumption contract that
`.claude/shipwright/consolidation-decisions.md` is one concrete instance of.

1. Check for `.claude/shipwright/consolidation-decisions.md` in the project root.
2. **If it does not exist**, treat this as "no suppressions configured" — the same
   graceful no-op `entropy-scan` uses for a missing `.claude/shipwright/principles.md`
   override. Print: "No consolidation-decisions.md found — no suppressions configured."
   and continue to Step 2 with an empty suppression list. This is expected on every
   run until a sibling task adds that file — it is not an error.
3. **If it exists**, load it and parse its entries. The exact field format is defined
   by whatever process authors that file (a human or a future skill) — read it
   generically: each entry describes (at minimum) a **pattern description** (what
   duplication was accepted as intentional debt) and, optionally, a **revisit
   condition** (a statement of when the acceptance should be reconsidered — e.g. a
   date, an occurrence threshold, or a triggering event). Do not assume a specific
   heading structure beyond "one entry per accepted pattern, with a description and
   an optional revisit condition" — parse defensively and skip entries you can't
   confidently interpret rather than failing the whole load.
4. Build an in-memory suppression list: one entry per parsed accepted-debt pattern,
   holding at least its description and revisit condition (if any).
5. Print the count of loaded suppressions, e.g. "Loaded 3 accepted-debt entries from
   consolidation-decisions.md."

This suppression list is consulted twice later: once loosely during the survey (Step
3, to avoid wasting effort re-describing a pattern already accepted as debt) and once
authoritatively before promotion (Step 7, which is the actual gate).

---

## Step 2: Load the Ledger (PatrolFinding) and Import Legacy State Once

The ledger lives in the task store as `PatrolFinding` rows keyed by
`(cronId = consolidation-patrol, repo, fingerprint)`. Read prior state through the
cron-run recorder:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/cron-run-recorder.ts prior \
  --cron consolidation-patrol --repo {org/repo} \
  --legacy-shape consolidation-ledger
```

It prints `{latest, findings, imported}` JSON (read-only). `findings` are the repo's
`PatrolFinding` rows (all pages already followed): each has `fingerprint`, `status`
(`tracking` | `ready_to_propose`), `firstSeen`, `lastSeen`, `occurrenceCount`,
`history`, and a `detail` object holding `description`, `files`, `notes`,
`consecutive_stable_runs`, `occurrence_count` and `proposed_shape`.

**One-time legacy import.** This is the only step that touches the old agent-local
ledger (`state/consolidation-ledger.json`). When the store has no prior run for this
repo and the legacy file holds candidates for it, the recorder returns them under
`imported`, already filtered to this repo (other repos' entries are ignored). Treat
`imported.findings` as the prior ledger for this run, and log
`Imported {N} legacy consolidation candidates for {repo}`. The recorder posts them
to the store and deletes the legacy file only after the `record` call in Step 8
succeeds, so a failed run leaves the file in place for a retry. After the import, no
step of this skill reads or writes that file again.

1. If both `findings` and `imported` are empty, the ledger is empty — a normal first
   run, not an error.
2. Effective prior counts: for each prior finding, the prior occurrence count is
   `max(occurrenceCount, detail.occurrence_count)` (an imported entry carries its
   legacy count in `detail.occurrence_count`). `consecutive_stable_runs`, `files`,
   `description`, `notes`, and the latest observation come from `detail`.
3. Keep every prior finding in memory — each is preserved untouched in Step 8
   unless this run's survey observed it.

---

## Step 3: Survey the Codebase (Judgment-Driven, Not a Clone Detector)

This is explicitly **not** an AST/token clone scan. Do not run or emulate jscpd,
SonarQube CPD, or a diff-based similarity tool. Instead:

1. Read broadly across the codebase's source directories (the plugin's own
   `plugins/shipwright/`, and — when scanning a target project rather than this repo
   itself — its own source layout). Favor breadth over exhaustive depth: sample
   representative files across each service/package rather than reading every file
   in full.
2. Group what you read by **purpose**, not by literal text — e.g. "things that retry
   a flaky operation with backoff," "things that validate an env var is set and
   parseable," "things that paginate a REST API via a cursor header." A candidate
   pattern is any responsibility you observe implemented **independently in 2 or
   more places** — independently meaning neither implementation calls or extends the
   other; if both call a shared helper, that's not duplication, it's already
   consolidated.
3. For each candidate, record:
   - A one-to-two sentence **pattern description** (the responsibility being
     duplicated, written generically enough to still apply if a third instance
     appears with slightly different code)
   - The **involved files** (each file/module implementing the responsibility
     independently), with line ranges where practical
   - A short note on **why they look like the same responsibility** (what's
     structurally or behaviorally shared, even if no lines are shared verbatim) —
     retain this note; it is persisted to the finding's `detail` and `history` in Step 8 and is
     what future runs compare against to judge shape stability
4. Before finalizing a candidate, loosely check it against the suppression list from
   Step 1 — if a suppression's pattern description clearly matches, you may skip
   spending further effort refining that candidate's description now (it will be
   filtered authoritatively in Step 7 regardless, so this is just an effort-saving
   shortcut, not the enforcement point).
5. **Stay conservative.** This is the highest-uncertainty part of the whole skill —
   prefer fewer, higher-confidence candidates over a firehose of speculative ones.
   A weak or borderline candidate that shouldn't have been flagged pollutes the
   ledger and can falsely accumulate `occurrence_count` over unrelated runs. When in
   doubt, leave it out — a real duplication will keep showing up on its own in
   future runs.

---

## Step 4: Weight Candidates by Churn

For each candidate's involved files, compute a recency/frequency signal from git
history:

```bash
git log -1 --format=%cd --date=relative -- <file>
git log --since="90 days ago" --oneline -- <file> | wc -l
```

- The first command gives how recently the file was last touched (e.g. "3 days ago").
- The second gives how many commits touched it in the last 90 days (a frequency
  signal).
- For a multi-file candidate, take the **most recently touched** file's recency and
  the **sum** of the 90-day commit counts across all involved files as the
  candidate's churn signal.
- If git history is unavailable for a file (e.g. it's untracked or the command
  errors), treat that file's churn as unknown/zero rather than failing the whole
  candidate.

Rank candidates churn-first (most recently/frequently touched first) — this is a
prioritization signal for the report and for triage effort, not a filter. A dormant
candidate is still tracked in the ledger; it just surfaces lower in ordering and is
less urgent, since files nobody is editing don't suffer from the "update the same
logic in two places" pain this skill exists to catch.

---

## Step 5: Compute a Fingerprint and Match Against the Ledger

The fingerprint is the join key between this run's candidates and the ledger's prior
entries. Getting this wrong means the stabilization counter (Step 6) never
accumulates correctly, so keep it conservative and deterministic:

1. **Normalize** the candidate's pattern description: lowercase, collapse
   whitespace, strip trailing punctuation.
2. **Sort** the candidate's involved file paths alphabetically.
3. **Fingerprint** = a stable hash (e.g. SHA-256, truncated to a short hex prefix
   for readability) of the normalized description concatenated with the sorted file
   list, e.g. `sha256(normalized_description + "|" + sorted_files.join(","))`.
4. For each of this run's candidates, look up its fingerprint in the ledger's
   `candidates` map from Step 2.
   - **Match found** → this is a recurrence of a tracked candidate; proceed to
     Step 6 to update its counters.
   - **No match** → this is a brand-new candidate; create a new finding with
     `occurrence_count: 1`, `consecutive_stable_runs: 0`, `status: "tracking"`,
     and this run's single observation as its `detail`. The store sets
     `firstSeen`/`lastSeen` and the `history` entry.

**Important limitation to keep in mind:** because the fingerprint includes the
involved file list, a candidate whose set of duplicated files changes materially
between runs (e.g. a third occurrence appears in a new file, or one occurrence gets
renamed/moved) will **not** match the prior fingerprint and will instead register as
a new candidate. This is a deliberate conservative tradeoff for the first version —
it undercounts recurrence rather than risking a false match that corrupts an
unrelated candidate's counters. Note this explicitly when reporting so a human
reviewing the ledger understands why a pattern might appear to "reset." Expect to
revisit this matching strategy after a few real runs.

---

## Step 6: Update Occurrence and Stability Counters

For every fingerprint match found in Step 5:

1. **Always increment `occurrence_count` by 1** (prior effective count from Step 2 plus one; the store's `occurrenceCount` is bumped by the same upsert).** A fingerprint match is by
   definition a recurrence of the same description + file set, so the raw count
   always goes up.
2. **Judge shape stability** before touching `consecutive_stable_runs`. Compare this
   run's candidate description/structure notes (from Step 3) against the ledger
   entry's most recently recorded `history` entry:
   - If the new instance's description and the "why they look like the same
     responsibility" reasoning are **consistent** with the prior recorded shape
     (same responsibility, same general approach — e.g. still "retry a flaky
     network call with backoff," implemented the same way structurally) →
     **increment `consecutive_stable_runs` by 1**.
   - If the new instance's implementation approach has **diverged meaningfully**
     from what was previously recorded (a different algorithm, a materially
     different scope, or the responsibility has forked into something no longer
     well-described by the stored description) → **reset `consecutive_stable_runs`
     to 0**. Note this only fires on an existing fingerprint match — since the
     fingerprint (Step 5) is keyed on the description text, a change large enough
     to alter the *generic* description itself (e.g. "retry with exponential
     backoff" becoming "retry with a fixed delay and no backoff") would already
     produce a different fingerprint and register as a new candidate in Step 5,
     never reaching this branch. What lands here instead is a matched fingerprint
     (same generic description, same files) whose recorded "why they look like the
     same responsibility" reasoning has drifted — e.g. the description still reads
     "retry a flaky network call with backoff" but this run's notes show the
     backoff calculation changed from exponential-with-jitter to a hardcoded fixed
     delay, a structural change not reflected in the (still-accurate-enough)
     generic description. Rule of Three applies to the *shape* stabilizing, not
     just the raw count — a candidate that keeps reappearing but keeps changing
     shape is not ready to propose a single canonical replacement for, because
     there's no settled target shape yet to propose.
   - This is a judgment call, not a mechanical diff — use the same reading
     comparison approach as Step 3. When genuinely unsure whether a change counts
     as divergence, treat it as divergence (reset) — the cost of under-promoting is
     low (it just tracks one more run), while the cost of over-promoting a still-
     shifting pattern is a report entry proposing a canonical shape that's already
     stale.
3. The store appends this run's observation to the finding's `history` when the
   upsert lands (Step 8) — prior history entries are never rewritten.
4. Set `detail.files`, `detail.description`, `detail.notes` to this run's
   observation (the store's `history` retains the full trail), and
   `detail.occurrence_count` / `detail.consecutive_stable_runs` to the new values.

---

## Step 7: Promote to `ready_to_propose`

For every candidate (new or matched) after Step 6's updates, evaluate promotion:

1. A candidate is promoted to `status: "ready_to_propose"` only if **all** of the
   following hold:
   - `occurrence_count >= 3`
   - `consecutive_stable_runs >= 2`
   - The candidate is **not suppressed** by the decisions registry loaded in Step 1
     — i.e. no accepted-debt entry's pattern description matches this candidate's
     description, *or* it matches but the suppression's revisit condition has been
     met (e.g. a stated revisit date has passed, or a stated occurrence threshold
     has now been exceeded). If a suppression matches and its revisit condition has
     **not** been met, the candidate stays suppressed regardless of how high its
     counters are.
2. If all three hold, set `status: "ready_to_propose"` on the finding.
3. Otherwise, the entry's `status` stays `"tracking"` — it is **silently tracked**,
   not listed in the docs file. This is the core "watch, don't act immediately" behavior this
   system exists to implement: a candidate can sit at `occurrence_count: 5` with
   `consecutive_stable_runs: 0` indefinitely (kept reappearing, but never in a
   settled shape) and it will never be promoted until its shape stabilizes for two
   consecutive runs.
4. A previously-`ready_to_propose` entry that becomes newly suppressed (a
   suppression was added since it was promoted) should be demoted back to
   `"tracking"` — the decisions registry is authoritative and always re-checked
   fresh each run, never cached from a prior promotion decision.

---

## Step 8: Write the Docs File, Then Record the Run and Upsert Findings

Skip all of this under `--dry-run` (print what would be written instead).

### 8a. Write `docs/patrols/consolidation.md` (readable only)

Build the file from the patterns that are open after Step 7 — the `ready_to_propose`
findings only. Tracking-but-not-yet-stable patterns stay in the store and never appear
in the file. The file is a human-readable list: per pattern a short title, why the
instances look like the same responsibility, the involved file paths, and the proposed
canonical shape. It carries **no** fingerprints, counters, sightings tables, run
history, resolved items or timestamps — all machine state lives in the task store, all
numbers in the run record. Order by churn (Step 4), highest first. It is capped at 150
lines: build it with `renderPatrolDoc` from
`${CLAUDE_PLUGIN_ROOT}/scripts/check-patrol-docs.ts` (one item per pattern; overflow
becomes a pointer line to the fix tasks).

Validate and detect material change against the repo's current file:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/check-patrol-docs.ts {candidate.md} docs/patrols/consolidation.md
```

It prints `{ violations, materiallyChanged }` and exits non-zero on violations. If
there are violations, fix the candidate and re-run; never commit a file that fails.
If `materiallyChanged` is false (including a timestamp-only change or a pure
reorder), **write nothing and open no PR** — the unchanged file opens no PR. When it
is true, commit the file on a docs branch (`docs/consolidation-patrol-{YYYYMMDD}`)
in the repo's worktree and open a docs PR with `gh pr create`, using the same docs-PR
path as `/shipwright:test-readiness` (reuse an existing open docs PR for the patrol
rather than opening a second one). The file is skipped under `--summary`.

### 8b. Record the run and upsert the findings

Write a result file (e.g. `/tmp/consolidation-result-{ts}.json`) and post it:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/cron-run-recorder.ts record \
  --cron consolidation-patrol --repo {org/repo} --commit {HEAD sha} \
  --result /tmp/consolidation-result-{ts}.json \
  --legacy-shape consolidation-ledger
```

The result file is `{ "outcome": "ok" | "no_op", "metrics": {...}, "findings": [...] }`:

- `findings`: one `{ fingerprint, status, detail }` per candidate **observed this
  run** (new or matched), with `status` `tracking` or `ready_to_propose` and
  `detail` = `{ description, files, notes, consecutive_stable_runs, occurrence_count, proposed_shape }`.
  The store upserts them: new fingerprints get `occurrenceCount` 1, continued ones
  `+1`, `lastSeen` updates, and a `history` entry is appended. Prior findings not
  observed this run are simply not sent — they stay in the store unchanged (a single
  miss is not evidence of resolution, so never delete or decay them). When Step 2
  returned `imported`, the recorder posts those legacy findings first.
- `metrics`: numeric counts for this run — `new`, `matched`, `promoted`,
  `ready_to_propose`, `tracking`, `suppressed`, `docs_pr` (1 if a docs PR was opened).
- `outcome`: `no_op` when nothing was observed and nothing changed, else `ok`.

The recorder posts **exactly one run** per invocation. If the scan itself fails
part-way, record the run with `{ "outcome": "failed", "metrics": {} }` and stop.
`--summary` still records the run and findings (only the docs file is skipped), so
the next run's counters stay correct.

---

## Step 9: Print Summary

Always print a summary to stdout after the scan:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONSOLIDATION SCAN COMPLETE — {org/repo}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  New candidates tracked this run:   {N}
  Candidates promoted this run:      {N}   (ready_to_propose)
  Total tracked, not yet ready:      {N}   (status: tracking, in the store)
  Suppressed by decisions registry:  {N}

{docs PR opened: "  Docs PR: {url}" | no material change: "  docs/patrols/consolidation.md unchanged — no PR."}
{If zero candidates are ready: "  ✓ No candidates ready to propose yet — {N} still accumulating stability."}

{If --dry-run: "Dry run — nothing written."}
{Else if --summary: "Summary only — docs file not written; findings and run still recorded."}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Constraints (Do Not Violate)

- **`--repo org/repo` is required.** One repo per run; missing flag is a usage error.
- **No code changes.** This skill reads and reports only. The only things it writes
  are `docs/patrols/consolidation.md` (via a docs PR, only on material change) and,
  through the recorder, the task store's findings and run record. Nothing is
  written in `--dry-run` mode.
- **No agent-local state.** The ledger is the store's `PatrolFinding` rows. The
  legacy agent-local ledger file is only ever read through the one-time import in
  Step 2.
- **No other git operations.** Beyond the docs branch/commit/PR in Step 8a, do not
  commit, branch, or stage anything. `git log` calls are read-only history
  inspection for churn-weighting.
- **No task-store task writes.** This skill never queues tasks — that is the
  `consolidation-fix` skill's job. It only writes findings and the run record.
- **Not a clone detector.** Never substitute a token/AST similarity tool or a diff-
  based heuristic for the judgment-driven comparison in Step 3.
- **Multiple runs before proposing, always.** Never list a pattern in
  `docs/patrols/consolidation.md` on its first observed occurrence — the
  `occurrence_count >= 3 AND consecutive_stable_runs >= 2` gate in Step 7 is not
  optional and does not have a "confidence override."
- **The decisions registry is authoritative and always re-checked live.** Never
  cache a past suppression decision — re-evaluate it every run against the current
  `.claude/shipwright/consolidation-decisions.md`.
- **Missing decisions file is not an error.** Scan normally with an empty
  suppression list.
- **Never silently drop a prior finding.** A candidate not observed in this run's
  survey stays in the store unchanged.
- **The docs file lists open patterns only**, within the 150-line cap, with no count
  tables and no run history; an unchanged file opens no PR.
- **`--dry-run` mutates nothing.** No docs file, no PR, no findings, no run record.
- **No new coupling.** Everything this skill reads or writes stays inside
  `plugins/shipwright/`, `.claude/shipwright/` (read-only), the repo's
  `docs/patrols/` file, and the task store through the recorder.
