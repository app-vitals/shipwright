# Decisions Registry Pattern

A generic description of the **decisions registry** pattern shared by two independent
patrol pipelines in this plugin: consolidation patrol (`consolidation-scan` /
`consolidation-fix`) and the test-readiness pipeline (`test-inventory` / `test-fix`). This
doc describes the pattern's shape once, abstracted from either concrete instance, so both
pipelines can point here instead of re-explaining the same mechanics twice. It does not
replace either instance's own full documentation — see "Concrete instances" below for where
that detail actually lives.

## Problem it solves

An automated scan or classification pass re-evaluates the codebase from scratch on every
run and has no memory of prior human judgment calls. Left alone, it re-flags the same
specific finding or ambiguous item forever, even after a human has already looked at it and
made a deliberate call (accept as debt, resolve at a different layer, reject a proposed
change). The decisions registry is a small, human-owned record of exactly those calls, so
the automated pass can consult it and stop re-flagging what's already been decided —
without the pass itself ever gaining write access to the decision.

## Generic entry schema

Each decision is one `###` heading with four fixed fields, always in this order:

```markdown
### <short name>

**Pattern:** <or **Item:** — what this entry covers>
**Decision:** <the explicit call that was made>
**Rationale:** <why>
**Revisit:** <the condition under which this decision should be reconsidered>
```

- **Pattern / Item** — the first field: a description of what this entry covers, concrete
  enough that a later automated pass can match a current candidate against it. The field is
  named `Pattern` in the consolidation instance (a duplication pattern) and `Item` in the
  test-readiness instance (an ambiguous coverage item) — same role, different name, because
  the two instances describe different kinds of things.
- **Decision** — the explicit call: accept as debt, resolve at a given layer, reject a
  proposal, or any other unambiguous outcome.
- **Rationale** — why that call is justified, for a future reader (human or the consuming
  skill) to evaluate.
- **Revisit** — a stated condition (a date, an occurrence/call-site threshold, or a named
  triggering event) under which the decision should be reconsidered rather than treated as
  permanent.

A consuming skill parses entries **generically and defensively**: it reads for these four
fields where present, without hardcoding assumptions about the registry's exact
heading/field layout beyond them, and skips any entry it can't confidently interpret rather
than failing the whole load.

## Ownership

The registry file is **human-edited only** — never written by the skill(s) that consume it,
and never generated or overwritten by any automated pass. A human adds or revises an entry
directly (typically while reviewing a patrol's proposed change, or proactively to pre-empt a
known-intentional pattern from being flagged).

## Consumption contract

- **Missing file → graceful no-op.** A registry file that doesn't exist yet is not an error
  — it means "nothing has been decided yet." The consuming skill treats this as an empty
  decision list and proceeds normally (e.g. "no suppressions configured" / "no decisions
  configured").
- **Present file → parsed defensively.** See the generic entry schema above — four fields,
  no hardcoded heading assumptions beyond them.
- **Matching is judgment-based, not exact-string equality.** A consuming skill compares its
  current candidate (a duplication pattern, an ambiguous coverage item) against each
  entry's Pattern/Item field by reading both descriptions and deciding whether they describe
  the same thing — the same comparison style used elsewhere in these pipelines for
  judgment-driven work, never a literal string match.
- **Revisit conditions are re-evaluated live, every run.** A matched entry whose Revisit
  condition has been met (a stated date has passed, a stated threshold has now been
  exceeded, or a stated triggering event has occurred) is treated as if it no longer
  applies — the candidate is not suppressed/resolved by it.
- **Never cached across runs.** The registry is always re-read and re-checked live against
  its current on-disk contents at the moment a skill consults it — never a decision cached
  from a prior run or a prior promotion/classification. A registry entry added since the
  last run is picked up immediately the next time any consuming skill checks.

## Concrete instances

This pattern currently has two concrete instances in this plugin. Each instance's own full
entry-format documentation, ownership detail, and worked examples live with the instance
itself — this doc only describes the shared shape, not either instance's complete detail.

- **`.claude/shipwright/consolidation-decisions.md`** — consumed by `consolidation-scan`
  (Step 1: loads it as a suppression list) and `consolidation-fix` (Step 3: cross-checks it
  once more before queueing). Full documentation: `docs/consolidation.md`'s "## The
  decisions registry" section.
- **`.claude/shipwright/test-readiness-decisions.md`** — consumed by `test-inventory`
  (Step 0: loads it as a decisions list) and `test-fix` (Step 4.5: cross-checks it once more
  before filing any task). Full documentation: the file's own top-of-file doc-comment.
