---
name: consolidation-scan
description: Discover emerging duplicate/similar code patterns via judgment-driven comparison, track them across runs in a ledger, and report only patterns that have stabilized. Report only — no code changes.
---

# Consolidation Scan

Survey the codebase for **emerging, unnamed** duplicate or near-duplicate logic —
the same responsibility implemented independently in two or more places — weight
candidates by how actively their files are being edited, and track them across
multiple weekly runs in a local ledger before proposing anything. This skill makes
**no code changes** — it reads and reports only.

**Scope note — how this differs from `entropy-scan`:** `entropy-scan` is stateless
and deterministic — it checks a fixed set of *named* rules from `references/principles.md`,
each with an explicit `**Detection:**` instruction, and every run stands alone.
`consolidation-scan` is the opposite shape: there is no named rule to check against.
It relies on judgment — an LLM reading and comparing the *purpose and structure* of
code across files and services — to notice duplication that a deterministic checker
can't name in advance. Because a single pass of judgment-driven comparison is noisy
and prone to one-off false positives, this skill never proposes anything from a
single run: it persists what it finds in `state/consolidation-ledger.json` and only
promotes a candidate once it has recurred, with a stable shape, across multiple runs
(Rule of Three — see Step 6-7). Static clone-detection tools (jscpd, SonarQube CPD)
are explicitly not used here — they only catch textual/token clones; this skill's
job is to catch *semantic* duplication that shares no lines at all (e.g. three
independently-written retry-with-backoff implementations).

---

## Setup: Parse Arguments

Before starting, check if any flags were passed:

- `--summary` — print counts to stdout; skip writing `consolidation-report.md`
- `--dry-run` — run the full scan (survey, churn-weighting, fingerprinting, ledger
  diffing) but skip writing `consolidation-report.md` **and** skip updating
  `state/consolidation-ledger.json`. Print everything that would have been written
  to stdout instead. Use this to validate the skill end-to-end without mutating any
  state.

---

## Step 1: Load the Decisions Registry (Suppressions)

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

## Step 2: Load the Ledger

1. Look for `state/consolidation-ledger.json` — agent workspace state, git-ignored,
   the same tier as `state/entropy-patrol-last-run.json` and
   `state/error-patrol-ledger.json` (see `error-scan`'s Step 5 for this tier's
   location convention — it sits alongside repo checkouts, not inside the invoking
   repo's working tree).
2. If it does not exist, treat the ledger as empty: `{"lastRun": null, "candidates": {}}`.
   This is a normal first run, not an error.
3. If it exists, read and parse it. Expected shape (full schema:
   `references/ledger-schema.md`):
   ```json
   {
     "lastRun": "<ISO8601 timestamp of previous run>",
     "candidates": {
       "<fingerprint>": {
         "description": "<normalized pattern description, as last recorded>",
         "files": ["<path>", "..."],
         "occurrence_count": <int>,
         "consecutive_stable_runs": <int>,
         "status": "tracking | ready_to_propose",
         "firstSeen": "<ISO8601>",
         "lastSeen": "<ISO8601>",
         "history": [
           { "run": "<ISO8601>", "description": "<description as observed that run>", "files": ["<path>", "..."] }
         ]
       }
     }
   }
   ```
4. Keep the full parsed ledger in memory — every existing entry must be preserved
   and written back in Step 8, whether or not this run's survey touched it.

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
     structurally or behaviorally shared, even if no lines are shared verbatim)
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
   - **No match** → this is a brand-new candidate; create a new ledger entry with
     `occurrence_count: 1`, `consecutive_stable_runs: 0`, `status: "tracking"`,
     `firstSeen`/`lastSeen` set to this run's timestamp, and a `history` array
     containing this run's single observation.

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

1. **Always increment `occurrence_count` by 1.** A fingerprint match is by
   definition a recurrence of the same description + file set, so the raw count
   always goes up.
2. **Judge shape stability** before touching `consecutive_stable_runs`. Compare this
   run's candidate description/structure notes (from Step 3) against the ledger
   entry's most recently recorded `history` entry:
   - If the new instance's description and the "why they look like the same
     responsibility" reasoning are **consistent** with the prior recorded shape
     (same responsibility, same general approach — e.g. still "retry with
     exponential backoff," not now "retry with a fixed delay and no backoff") →
     **increment `consecutive_stable_runs` by 1**.
   - If the new instance's implementation approach has **diverged meaningfully**
     from what was previously recorded (a different algorithm, a materially
     different scope, or the responsibility has forked into something no longer
     well-described by the stored description) → **reset `consecutive_stable_runs`
     to 0**. Rule of Three applies to the *shape* stabilizing, not just the raw
     count — a candidate that keeps reappearing but keeps changing shape is not
     ready to propose a single canonical replacement for, because there's no
     settled target shape yet to propose.
   - This is a judgment call, not a mechanical diff — use the same reading
     comparison approach as Step 3. When genuinely unsure whether a change counts
     as divergence, treat it as divergence (reset) — the cost of under-promoting is
     low (it just tracks one more run), while the cost of over-promoting a still-
     shifting pattern is a report entry proposing a canonical shape that's already
     stale.
3. Append this run's observation (description, files, timestamp) to the entry's
   `history` array — never truncate or overwrite prior history entries.
4. Update `lastSeen` to this run's timestamp and `files` to this run's observed file
   list (the most recent observation, for report display — `history` retains the
   full trail).

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
2. If all three hold, set `status: "ready_to_propose"` on the ledger entry.
3. Otherwise, the entry's `status` stays `"tracking"` — it is **silently tracked**,
   not reported. This is the core "watch, don't act immediately" behavior this
   system exists to implement: a candidate can sit at `occurrence_count: 5` with
   `consecutive_stable_runs: 0` indefinitely (kept reappearing, but never in a
   settled shape) and it will never be promoted until its shape stabilizes for two
   consecutive runs.
4. A previously-`ready_to_propose` entry that becomes newly suppressed (a
   suppression was added since it was promoted) should be demoted back to
   `"tracking"` — the decisions registry is authoritative and always re-checked
   fresh each run, never cached from a prior promotion decision.

---

## Step 8: Write the Ledger

Skip this step entirely if `--dry-run` was passed.

1. Build the full ledger content — every entry from Step 2's loaded ledger, with
   this run's new/matched entries merged in (updated counters, updated `status`,
   appended `history`). Entries that existed in the prior ledger but had no
   corresponding candidate this run are preserved unchanged (a candidate not
   observed this run is not evidence it's gone — a survey is a sample, not
   exhaustive; do not delete or decay entries for a miss in a single run).
2. Set `lastRun` to this run's current UTC ISO-8601 timestamp.
3. Overwrite `state/consolidation-ledger.json` with this content — a full replace,
   the same "current-state snapshot" convention `error-scan` uses for
   `state/error-patrol-ledger.json` (not an append-only log like `entropy-scan`'s
   quality log).
4. Print: `Ledger updated: state/consolidation-ledger.json`

---

## Step 9: Write the Report

Skip this step if `--summary` or `--dry-run` was passed.

Write `consolidation-report.md` to the project root (overwrite if it exists). It
lists **only** entries with `status: "ready_to_propose"` after Step 7 — entries
still `tracking` never appear here, no matter how high their `occurrence_count` is.
Format:

```markdown
# Consolidation Report

**Generated:** {YYYY-MM-DD HH:MM} {timezone}
**Decisions registry:** {".claude/shipwright/consolidation-decisions.md" | "none found — no suppressions configured"}
**Candidates ready to propose:** {count}
**Candidates still tracking (not shown below):** {count}

---

## Ready to Propose

{If none: "No candidates have stabilized enough to propose yet. Run /consolidation-scan again in future weeks to keep building history."}

{For each ready_to_propose entry:}
### {short pattern description}

**Fingerprint:** `{fingerprint}`
**Occurrences:** {occurrence_count} · **Consecutive stable runs:** {consecutive_stable_runs}
**First seen:** {firstSeen} · **Last seen:** {lastSeen}

**Occurrences (most recent observation):**
- `{file_path}:{line_range}` — {brief note on this instance}
- `{file_path}:{line_range}` — {brief note on this instance}

**Proposed canonical shape:** {one paragraph describing the shared responsibility and a plausible single implementation/interface that would replace all occurrences — a starting point for a human or a follow-up task, not a mandate}

**Stability history:**
{One line per history entry: run timestamp → description observed that run}

---

{Repeat for each ready_to_propose entry, churn-weighted order (most recently/frequently touched files first, per Step 4)}

---
_Tracked-but-not-yet-stable candidates are not listed here — see `state/consolidation-ledger.json` for the full ledger. This report only reflects candidates that met occurrence_count >= 3 and consecutive_stable_runs >= 2._
```

Rules:
- Only `ready_to_propose` entries are ever written to this file — this is the
  primary behavioral contract of the skill.
- Each run fully overwrites `consolidation-report.md` — the ledger, not old
  reports, is the historical record.

---

## Step 10: Print Summary

Whether or not `--summary` was passed, always print a summary to stdout after the
scan:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONSOLIDATION SCAN COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  New candidates tracked this run:   {N}
  Candidates promoted this run:      {N}   (ready_to_propose)
  Total tracked, not yet ready:      {N}   (status: tracking, in ledger)
  Suppressed by decisions registry:  {N}

{If any candidates were promoted this run:}
  Report written to: consolidation-report.md

{If zero candidates were promoted this run:}
  ✓ No candidates ready to propose yet — {N} still accumulating stability.

{If --dry-run: "Dry run — no files written."}
{Else if --summary: "Summary only — consolidation-report.md not written; ledger still updated."}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Constraints (Do Not Violate)

- **No code changes.** This skill reads and reports only. The only files it writes
  are `consolidation-report.md` (project root) and `state/consolidation-ledger.json`
  (agent workspace state) — and neither is written in `--dry-run` mode.
- **No git operations.** Do not commit, branch, or stage anything. `git log` calls
  are read-only history inspection for churn-weighting.
- **No PR creation and no task-store writes.** This skill never queues tasks —
  unlike `entropy-fix`, there is currently no `consolidation-fix` counterpart;
  proposals in `consolidation-report.md` are for human/future-task triage.
- **Not a clone detector.** Never substitute a token/AST similarity tool or a diff-
  based heuristic for the judgment-driven comparison in Step 3 — that changes what
  this skill catches and defeats its purpose.
- **Multiple runs before proposing, always.** Never write an entry to
  `consolidation-report.md` on its first observed occurrence — the
  `occurrence_count >= 3 AND consecutive_stable_runs >= 2` gate in Step 7 is not
  optional and does not have a "confidence override."
- **The decisions registry is authoritative and always re-checked live.** Never
  cache a past suppression decision — an entry's suppressed/promoted state is
  re-evaluated fresh every run against the current
  `.claude/shipwright/consolidation-decisions.md` contents.
- **Missing decisions file is not an error.** Same graceful-degradation contract as
  `entropy-scan`'s missing `principles.md` override — scan and report normally with
  an empty suppression list.
- **Ledger is a snapshot, not a log.** `state/consolidation-ledger.json` is fully
  overwritten each run with current state (all entries, not just this run's), same
  convention as `error-scan`'s ledger — except `history` arrays within each entry
  are themselves append-only and must never be truncated.
- **Never silently drop a prior ledger entry.** A candidate not observed in this
  run's survey stays in the ledger unchanged — a single miss is not evidence of
  resolution.
- **`--dry-run` mutates nothing.** No report write, no ledger write — everything
  that would be written is printed to stdout instead.
- **`--summary` skips only the report file**, not the ledger update — the ledger
  must stay current so the next run's occurrence/stability counters are correct
  regardless of which flag was used.
- **No new coupling.** Everything this skill reads or writes stays inside
  `plugins/shipwright/` (this skill file and its references), `.claude/shipwright/`
  (project-level config, read-only), and `state/` (agent workspace state) — no
  external service dependency, no hardcoded repo name.
