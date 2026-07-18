# Consolidation Decisions

A repo-tracked, project-level registry of duplication/pattern decisions made over
time. This is not a set of detection rules (that's `references/principles.md`) —
it's a record of specific `consolidation-scan` findings that were looked at and
deliberately accepted as debt, so the scan stops re-flagging them every run.

**Who edits this file:** humans, not agents. Entries are added during review of a
`consolidation-fix` PR (when a proposed convergence is rejected as not worth doing
right now) or proactively (when the team already knows a pattern is duplicated by
design and wants to pre-empt the scan flagging it). This file lives at the same
override tier as `.claude/shipwright/principles.md` — repo-local, human-owned,
loaded by the skill but never written by it.

**How `consolidation-scan` consumes it:** Step 1 of the skill checks for this file.
If it's missing, that's a graceful no-op — "no suppressions configured" — the same
tier as a missing `principles.md` override. If it exists, the skill loads and parses
entries generically (it does not hardcode the exact heading/field structure below —
it reads defensively for "one entry per accepted pattern, with a description and an
optional revisit condition" and skips anything it can't confidently interpret) and
builds an in-memory suppression list. That list is consulted twice: loosely during
the survey (to avoid re-describing an already-accepted pattern) and authoritatively
before promotion (the actual gate that stops a suppressed pattern from being
reported again) — unless the entry's revisit condition has been met, in which case
the suppression no longer applies and the pattern is eligible to resurface.

---

## Entry Format

Each decision is one `###` entry with a fixed field order:

```
### <short pattern name>

**Pattern:** <what duplication/pattern this covers — specific enough that
  consolidation-scan's fingerprint for it can be matched against this entry>
**Decision:** <accept as debt | reject convergence | other explicit call>
**Rationale:** <why this is justified complexity, not accidental duplication>
**Revisit:** <the condition under which this decision should be reconsidered —
  an occurrence-count threshold, a churn signal, a triggering event, or a date>
```

Keep **Pattern** concrete enough to match against a real fingerprint, not a vague
category — a future reader (human or `consolidation-scan` itself) should be able to
tell whether a newly-surveyed candidate is "the same thing" as this entry.

---

## Decisions

### No abstraction layer over Claude Code

**Pattern:** Shipwright's plugin, agent, and services couple directly to Claude
Code's APIs and conventions in multiple places (command/skill definitions, the
agent's session-driving logic, config surfaces) rather than going through a shared
internal abstraction. Looked at superficially, this can resemble duplicated
"Claude-Code-specific glue" scattered across the codebase — a pattern
`consolidation-scan` could plausibly flag as worth converging behind one interface.
**Decision:** Do not build a shared abstraction layer over Claude Code. Shipwright
is built directly on top of Claude Code by design.
**Rationale:** Direct coupling keeps upgrading to new Claude Code features easy —
there's no intermediate layer to update, extend, or reconcile first. It also means
the team doesn't have to reason about an extra abstraction boundary that, today,
has exactly one implementation behind it and therefore adds indirection without
adding flexibility. This is justified complexity (or rather, justified
non-abstraction) that should not be flagged for consolidation — it's distinct from
accidental duplication that should converge, because there is no second
implementation for an abstraction to unify.
**Revisit:** Revisit if Shipwright needs to support a second agent harness or LLM
provider — at that point an abstraction boundary becomes justified, because there
would be a real second implementation to unify behind a shared interface.
