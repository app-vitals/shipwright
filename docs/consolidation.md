# Consolidation

> Automated discovery and tracking of emerging code duplication patterns. The `consolidation-scan` skill identifies semantic duplicates (retries, caching layers, error handling patterns); the `consolidation-fix` skill proposes extraction and refactoring via task-store tasks; and the `consolidation-patrol` system cron runs them once per repo on a weekly schedule, keeping the ledger of observed patterns in the task store.

## Overview

Code duplication is normal — patterns emerge independently across a large codebase as the team solves similar problems in different contexts. Some duplication is justified (a pattern genuinely fits two different use cases better than one abstraction), but some is accidental and worth converging. The **consolidation-patrol** subsystem helps surface candidates for that latter category through a three-layer system:

1. **Detection layer** — `consolidation-scan` surveys the codebase for emerging, unnamed duplicate/near-duplicate logic using semantic judgment (not a clone-detection tool like jscpd or SonarQube CPD — it catches *shape and responsibility*, not text similarity). It is report-only: no code changes.
2. **Decision layer** — a human-edited registry (`.claude/shipwright/consolidation-decisions.md`) records specific findings that were looked at and deliberately accepted as debt, so the system stops re-flagging them.
3. **Action layer** — `consolidation-fix` queues task-store tasks for promising candidates, using a strangler-fig execution plan (Build → Coexist → Eliminate) to safely extract and converge duplicates.

The system is driven by the `consolidation-patrol` system cron (seeded disabled, enabled and scoped by an operator).

## What `consolidation-scan` does

`consolidation-scan` runs a judgment-driven survey of the codebase, looking for emerging, unnamed duplicate/near-duplicate logic. It requires `--repo org/repo` (one repo per run). It loads the decisions registry as a suppression list (missing file is a graceful no-op) and the repo's prior findings from the task store to track what's been observed across runs. For each new or continued candidate, it:

1. Computes a fingerprint: `sha256(normalize(description) + "|" + sorted(files).join(","))`, truncated to a short hex prefix. The fingerprint is stable across runs if the description and involved file set remain consistent.
2. Increments `occurrence_count` if the fingerprint was seen before, or creates a new ledger entry.
3. Increments `consecutive_stable_runs` if the shape is judged consistent with prior observations, or resets it to `0` if it diverges.
4. Applies the **Rule of Three** promotion logic (see below) to decide whether the candidate is "ready to propose" for consolidation.
5. Upserts the observed candidates as `PatrolFinding` rows and records exactly one run (with metrics) through `plugins/shipwright/scripts/cron-run-recorder.ts`.
6. Writes `docs/patrols/consolidation.md`, listing only open (`ready_to_propose`) patterns — tracking candidates never appear, no matter how high their `occurrence_count`. The file is validated by `check-patrol-docs.ts` (150-line cap, no count tables, no run history) and committed through a docs PR only on material change; an unchanged file opens no PR.

Supports `--summary` (skip the docs file) and `--dry-run` (write nothing, print to stdout).

## What `consolidation-fix` does

`consolidation-fix` requires `--repo org/repo`, reads the repo's `ready_to_propose` findings from the task store (requiring `consolidation-scan` to have run first), re-validates each `ready_to_propose` entry against the live decisions registry, and queues task-store tasks for consolidation work. For each surviving candidate, it builds a **strangler-fig execution plan**:

- **Build:** Land the canonical implementation in isolation, no call sites changed yet. Tests and CI must pass.
- **Coexist:** Migrate call sites one at a time (or in small, topically-related batches), each in its own PR. Both old and new implementations run in parallel; tests for both must pass.
- **Eliminate:** Remove old implementation(s) once every occurrence is migrated, in a final small PR.

This three-phase approach reduces risk by never leaving the codebase in a state where old and new don't both work.

Each candidate is then routed one of three ways, per the finding-routing contract in [`docs/task-store.md`](./task-store.md#finding-routing-auto--review--plan):
- **auto** — a single clear canonical shape with existing precedent and a single-PR fix: a pending dev task.
- **review** — a single-PR fix that needs a human answer first (multiple plausible shapes, unconfirmed occurrences): a dev task created blocked with a `needs-review:` reason.
- **plan** — a strangler-fig plan spanning several PRs, crossing service or repo boundaries, or more than roughly five call sites: a `kind: prd`, `hitl: true` task that a human takes through `/shipwright:prd` or `/shipwright:plan-session`. This is the only route that sets `hitl: true`.

Tasks are queued to the task store (never opened as PRs directly, with `originKind: "cron"`) with id format `consolidation-{fingerprint-or-slug}-{repo-slug}-{YYYY-Www}` (ISO week), title `Consolidation: {pattern description}`, and branch `feat/consolidation-{fingerprint-or-slug}-{short-description}`. Auto tasks run through the normal dev loop; humans unblock review tasks and plan tasks. Run metrics count `auto`, `review` and `plan` separately.

Supports `--dry-run` (preview only) and `--pattern {fingerprint}` (queue only one candidate).

## The ledger: `PatrolFinding` rows in the task store

The ledger lives in the task store as `PatrolFinding` rows keyed by `(cronId = consolidation-patrol, repo, fingerprint)`, so any agent that claims a repo's task sees the same history. Nothing is kept in agent-local `state/` files. The only readable output in the repo is `docs/patrols/consolidation.md`: open patterns only, capped at 150 lines, no counts and no run history (those stay in the store).

**One-time import.** On a repo's first run the store has no prior run. If the agent still has the legacy local ledger, `cron-run-recorder.ts prior --legacy-shape consolidation-ledger` returns that file's candidates filtered to the repo, they become the first run's findings, and the file is deleted after the run is recorded successfully. This preserves the multi-week stabilization history across the cutover. After that the legacy file is never read again.

### Finding shape

Each row carries the store's `status`, `firstSeen`, `lastSeen`, `occurrenceCount` and append-only `history`. The scan keeps the rest in `detail`:

| Field | Type | Description |
|-------|------|-------------|
| `fingerprint` | string | Join key (see below). |
| `status` | `"tracking"` \| `"ready_to_propose"` | `"tracking"` until promotion criteria are met (see below); `"ready_to_propose"` once promoted. Can move back to `"tracking"` if a suppression is added after promotion. |
| `detail.description` | string | Most recently recorded pattern description. |
| `detail.files` | string[] | Most recently observed involved files/line ranges. |
| `detail.occurrence_count` | number | Effective number of runs in which this fingerprint was observed (includes an imported legacy count). Never decremented. |
| `detail.consecutive_stable_runs` | number | Most recent streak of runs judged consistent with the prior shape. Reset to `0` on any judged divergence. |
| `detail.notes`, `detail.proposed_shape` | string | Why the instances look like the same responsibility, and the proposed canonical shape. |

### Fingerprint

The fingerprint is a stable hash of the candidate's **normalized description** joined with its **sorted involved file list**:

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

## The cron: `consolidation-patrol`

`consolidation-patrol` is a system cron: the admin scheduler queues one task per repo (`/shipwright:consolidation-scan --repo {repo}` then `/shipwright:consolidation-fix --repo {repo}`) on a weekly schedule (Monday at 05:00 UTC, cron expr `0 5 * * 1`). It is seeded **disabled**; an operator enables it and scopes it to repos on the admin system-crons page. Each run appends one run record (outcome, commit, metrics) to the repo's run history. See the system-cron contract in [`docs/task-store.md`](./task-store.md#system-cron-contract).

## See also

- [`plugins/shipwright/skills/consolidation-scan/SKILL.md`](../plugins/shipwright/skills/consolidation-scan/SKILL.md) — the scan skill
- [`plugins/shipwright/skills/consolidation-fix/SKILL.md`](../plugins/shipwright/skills/consolidation-fix/SKILL.md) — the fix skill
- [`plugins/shipwright/skills/consolidation-scan/references/ledger-schema.md`](../plugins/shipwright/skills/consolidation-scan/references/ledger-schema.md) — the finding `detail` schema and the legacy shape the one-time import reads
- [`.claude/shipwright/consolidation-decisions.md`](../.claude/shipwright/consolidation-decisions.md) — the decisions registry
- [`plugins/shipwright/references/decisions-registry.md`](../plugins/shipwright/references/decisions-registry.md) — the shared decisions-registry pattern this registry is one instance of (also consumed by test-inventory/test-fix and prompt-scan)
- [`plugins/shipwright/scripts/cron-run-recorder.ts`](../plugins/shipwright/scripts/cron-run-recorder.ts) — the run recorder and legacy import
- [`plugins/shipwright/scripts/check-patrol-docs.ts`](../plugins/shipwright/scripts/check-patrol-docs.ts) — validates `docs/patrols/consolidation.md`
