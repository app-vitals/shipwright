# Consolidation

> Automated discovery and tracking of emerging code duplication patterns. The `consolidation-scan` skill identifies semantic duplicates (retries, caching layers, error handling patterns); the `consolidation-fix` skill proposes extraction and refactoring via task-store tasks; and the `consolidation-patrol-maintenance` cron runs them on a weekly schedule, maintaining a persistent ledger of observed patterns.

## Overview

Code duplication is normal — patterns emerge independently across a large codebase as the team solves similar problems in different contexts. Some duplication is justified (a pattern genuinely fits two different use cases better than one abstraction), but some is accidental and worth converging. The **consolidation-patrol** subsystem helps surface candidates for that latter category through a three-layer system:

1. **Detection layer** — `consolidation-scan` surveys the codebase for emerging, unnamed duplicate/near-duplicate logic using semantic judgment (not a clone-detection tool like jscpd or SonarQube CPD — it catches *shape and responsibility*, not text similarity). It is report-only: no code changes.
2. **Decision layer** — a human-edited registry (`.claude/shipwright/consolidation-decisions.md`) records specific findings that were looked at and deliberately accepted as debt, so the system stops re-flagging them.
3. **Action layer** — `consolidation-fix` queues task-store tasks for promising candidates, using a strangler-fig execution plan (Build → Coexist → Eliminate) to safely extract and converge duplicates.

The system is driven by the `consolidation-patrol-maintenance` cron (disabled by default, opt-in per agent).

## What `consolidation-scan` does

`consolidation-scan` runs a judgment-driven survey of the codebase, looking for emerging, unnamed duplicate/near-duplicate logic. It loads the decisions registry as a suppression list (missing file is a graceful no-op) and the persistent ledger to track what's been observed across runs. For each new or continued candidate, it:

1. Computes a fingerprint: `sha256(normalize(description) + "|" + sorted(files).join(","))`, truncated to a short hex prefix. The fingerprint is stable across runs if the description and involved file set remain consistent.
2. Increments `occurrence_count` if the fingerprint was seen before, or creates a new ledger entry.
3. Increments `consecutive_stable_runs` if the shape is judged consistent with prior observations, or resets it to `0` if it diverges.
4. Applies the **Rule of Three** promotion logic (see below) to decide whether the candidate is "ready to propose" for consolidation.
5. Writes the full ledger back — a current-state snapshot, fully overwritten each run (except each entry's `history` array, which is append-only).
6. Generates `consolidation-report.md` at the project root, listing only `ready_to_propose` entries (matching candidates never appear in the report, no matter how high their `occurrence_count`).

Supports `--summary` (skip report write) and `--dry-run` (skip both report and ledger write, print to stdout).

## What `consolidation-fix` does

`consolidation-fix` reads `consolidation-report.md` (requiring `consolidation-scan` to have run first), re-validates each `ready_to_propose` entry against the live decisions registry, and queues task-store tasks for consolidation work. For each surviving candidate, it builds a **strangler-fig execution plan**:

- **Build:** Land the canonical implementation in isolation, no call sites changed yet. Tests and CI must pass.
- **Coexist:** Migrate call sites one at a time (or in small, topically-related batches), each in its own PR. Both old and new implementations run in parallel; tests for both must pass.
- **Eliminate:** Remove old implementation(s) once every occurrence is migrated, in a final small PR.

This three-phase approach reduces risk by never leaving the codebase in a state where old and new don't both work.

For each candidate, `consolidation-fix` also classifies a `hitl` (human-in-the-loop) flag:
- `hitl: false` when there's a single clear canonical shape with existing precedent in the codebase, and the migration touches few call sites (typically one or two).
- `hitl: true` when there are multiple plausible canonical shapes, the migration crosses service/repo boundaries, or there are more than roughly five call sites.

Tasks are queued to the task store (never opened as PRs directly) with id format `consolidation-{fingerprint-or-slug}-{repo-slug}-{YYYY-Www}` (ISO week), title `Consolidation: {pattern description}`, and branch `feat/consolidation-{fingerprint-or-slug}-{short-description}`. The `dev-task` command picks them up later, or humans review HITL tasks directly.

Supports `--dry-run` (preview only) and `--pattern {fingerprint}` (queue only one candidate).

## The ledger: `state/consolidation-ledger.json`

The consolidation ledger is agent workspace state (`state/` directory, git-ignored), the same tier as `state/entropy-patrol-last-run.json` and `state/error-patrol-ledger.json`. It's a **current-state snapshot** — fully overwritten each run (same convention as `state/error-patrol-ledger.json`), except each entry's own `history` array, which is append-only.

### Top-level shape

```json
{
  "lastRun": "2026-07-18T09:00:00.000Z",
  "candidates": {
    "<fingerprint>": { }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `lastRun` | ISO-8601 string \| `null` | UTC timestamp of the most recent scan run. `null` if the ledger has never been written (fresh/empty). |
| `candidates` | object | Map of fingerprint → candidate entry (see below). One entry per distinct duplication pattern ever observed. |

### Candidate entry shape

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Most recently recorded pattern description (human-readable, generic enough to describe the responsibility even as new occurrences appear). |
| `files` | string[] | Most recently observed involved files/line ranges. `history` retains prior observations; this field is the current snapshot used for report display. |
| `occurrence_count` | number | Total number of runs in which this fingerprint was observed (matched or newly created). Incremented on every fingerprint match — never decremented. |
| `consecutive_stable_runs` | number | Number of consecutive runs (most recent streak) in which the observed shape was judged consistent with the prior recorded shape. Reset to `0` on any judged divergence. |
| `status` | `"tracking"` \| `"ready_to_propose"` | `"tracking"` until promotion criteria are met (see below); `"ready_to_propose"` once promoted. Can move back to `"tracking"` if a suppression is added after promotion. |
| `firstSeen` | ISO-8601 string | Timestamp of the run that first created this entry. |
| `lastSeen` | ISO-8601 string | Timestamp of the most recent run that observed this fingerprint. |
| `history` | array | Append-only trail of every observation of this fingerprint: `{ run, description, notes, files }` per run. Never truncated or rewritten. |

### Fingerprint

The map key is a stable hash of the candidate's **normalized description** joined with its **sorted involved file list**:

```
fingerprint = sha256(normalize(description) + "|" + sorted(files).join(","))
```

Where `normalize()` lowercases, collapses whitespace, and strips trailing punctuation. The hash is truncated to a short hex prefix (e.g. 12 characters) for readability.

**Known limitation:** because the file list is part of the fingerprint, a candidate whose involved files change materially between runs (a new occurrence appears in a different file, or a file is renamed) produces a different fingerprint and is treated as a new candidate. This is a deliberate conservative tradeoff — favoring undercounting over a looser match that could conflate two unrelated candidates.

### Promotion rule — the Rule of Three

A candidate's `status` becomes `"ready_to_propose"` only when **all three** of the following are true (re-evaluated fresh every run):

1. `occurrence_count >= 3` — observed in at least three runs.
2. `consecutive_stable_runs >= 2` — the last two runs judged the shape consistent.
3. Not currently suppressed by `.claude/shipwright/consolidation-decisions.md` (or the suppression's revisit condition has been met).

All three conditions are always re-validated; nothing is permanently promoted or suppressed independent of current ledger and decisions-registry state.

## The decisions registry: `.claude/shipwright/consolidation-decisions.md`

The decisions registry is a **repo-tracked, human-edited** file at `.claude/shipwright/consolidation-decisions.md` (same tier as `.claude/shipwright/principles.md`). It records specific `consolidation-scan` findings that were looked at and deliberately accepted as debt, so the system stops re-flagging them.

### Who edits it and when

Humans only — not agents. Entries are added:
- During review of a `consolidation-fix` PR when a proposed convergence is rejected as not worth doing right now.
- Proactively, when the team already knows a pattern is duplicated by design and wants to pre-empt the scan flagging it.

Missing file is a graceful no-op ("no suppressions configured"), the same tier as a missing `principles.md` override.

### Entry format

Each decision is one `###` heading with four fields in fixed order:

```markdown
### <short pattern name>

**Pattern:** <what duplication this covers — specific enough that
  consolidation-scan's fingerprint can be matched against this entry>
**Decision:** <accept as debt | reject convergence | other explicit call>
**Rationale:** <why this is justified complexity, not accidental duplication>
**Revisit:** <condition under which this decision should be reconsidered —
  occurrence-count threshold, churn signal, triggering event, or date>
```

Keep **Pattern** concrete enough to match against a real fingerprint. A future reader (human or `consolidation-scan` itself) should be able to tell whether a newly-surveyed candidate is "the same thing" as this entry.

### How to add an entry

1. Create a new `###` heading with a short pattern name.
2. Fill in the four fields in the order above, with concrete descriptions.
3. Commit and push as a normal PR or direct commit (this is repo state, not generated).

### How to revise an entry

1. Locate the existing `###` block for the pattern.
2. Edit any of the four fields (e.g., update `**Revisit:**` after reconsidering, or change `**Decision:**` if the judgment has evolved).
3. Commit and push.

The registry is always re-checked live by `consolidation-scan` before promotion, never cached across runs.

## The cron: `consolidation-patrol-maintenance`

The `consolidation-patrol-maintenance` cron runs `consolidation-scan` and `consolidation-fix` in sequence on a weekly schedule (Monday at 05:00 UTC, cron expr: `0 5 * * 1`). It is **disabled by default** — agents must opt in to enable it.

### Configuration

| Field | Value | Notes |
|-------|-------|-------|
| **Schedule** | `0 5 * * 1` | Weekly, Monday at 05:00 UTC. |
| **Prompt** | `/shipwright:consolidation-scan` → `/shipwright:consolidation-fix` | Runs both skills in sequence; only posts to Slack if `ready_to_propose` findings exist. |
| **preCheck** | `shipwright:check-consolidation-patrol.ts` | Scans the ledger for candidates worth waking a full Claude session: either already `ready_to_propose`, or still `tracking` but one observation away from the stabilization threshold (`occurrence_count >= 2`). Missing ledger → exits silently (normal first run). |
| **Enabled** | `false` | Disabled by default. Recommended to stay disabled after merge until `state/consolidation-ledger.json` has accumulated a few weeks of real signal. |

### How to enable it

Toggle in the agent's admin UI (`/admin/agents/{id}/crons`) or via the API:

```bash
curl -X PATCH "https://<admin-url>/agents/<id>/crons/<cronId>" \
  -H "Authorization: Bearer $SHIPWRIGHT_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

The same mechanism applies to all opt-in crons — see `docs/agent.md`'s "Default system crons" section for the full flow.

### The preCheck script

`plugins/shipwright/scripts/check-consolidation-patrol.ts` reads `state/consolidation-ledger.json` and looks for candidates worth waking Claude for:
- Already `ready_to_propose` (met the Rule of Three).
- Still `tracking` but with `occurrence_count >= 2` — one observation away from the count threshold (note: `occurrence_count` alone doesn't promote a candidate; `consecutive_stable_runs` and suppression checks also apply — the preCheck is just a cheap signal, and `consolidation-scan`/`consolidation-fix` remain authoritative).

Missing ledger → exits silently (normal first run). Ledger present but unparsable → exits permissively (unknown state). Zero interesting candidates → exits silently. At least one → exits with a short summary, which becomes the actual cron prompt, so the cron only spends a Claude turn when there's real signal.

## See also

- [`plugins/shipwright/skills/consolidation-scan/SKILL.md`](../plugins/shipwright/skills/consolidation-scan/SKILL.md) — the scan skill
- [`plugins/shipwright/skills/consolidation-fix/SKILL.md`](../plugins/shipwright/skills/consolidation-fix/SKILL.md) — the fix skill
- [`plugins/shipwright/skills/consolidation-scan/references/ledger-schema.md`](../plugins/shipwright/skills/consolidation-scan/references/ledger-schema.md) — full ledger schema reference with JSON examples
- [`.claude/shipwright/consolidation-decisions.md`](../.claude/shipwright/consolidation-decisions.md) — the decisions registry
- [`plugins/shipwright/scripts/check-consolidation-patrol.ts`](../plugins/shipwright/scripts/check-consolidation-patrol.ts) — the preCheck script
