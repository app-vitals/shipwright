# Test Readiness Decisions

A repo-tracked, project-level registry of test-readiness "Ambiguous items" HITL
decisions made over time. This is not a set of gap-detection rules (that lives in
the `test-inventory`/`test-fix` skills themselves) — it's a record of specific
ambiguous coverage calls that were looked at and deliberately resolved, so future
`test-inventory`/`test-migration`/`test-fix` cycles stop re-flagging them.

**Who edits this file:** humans, not agents. Entries are added during review of a
test-readiness HITL decision (when an "Ambiguous item" — a case where the right
test layer or coverage approach isn't clear-cut — is resolved one way or another)
or proactively (when the team already knows a coverage gap is intentional and
wants to pre-empt future cycles re-flagging it). This file lives at the same
override tier as `.claude/shipwright/consolidation-decisions.md` and
`.claude/shipwright/principles.md` — repo-local, human-owned, intended to be
loaded by the skills but never written by them (see the consumption note below
for the current not-yet-wired-in status).

**How `test-inventory` and `test-fix` will consume it:** this consumption step is
**not yet implemented** — tracked as a follow-up. The intended mechanism (mirroring
`consolidation-scan`'s "Step 1: Load the Decisions Registry" for
`consolidation-decisions.md`) is: each skill would check for this file at the
start of its ambiguous-item handling. If it's missing, that would be a graceful
no-op — "no durable decisions recorded" — the same tier as a missing
`principles.md` override. If it exists, the skills would load and parse entries
generically (not hardcoding the exact heading/field structure below — reading
defensively for "one entry per resolved item, with a decision and an optional
revisit condition" and skipping anything they can't confidently interpret) and
build an in-memory resolved-items list. That list would be consulted before an
item is (re-)surfaced as ambiguous — the gate that stops an already-resolved item
from being reported again — unless the entry's revisit condition has been met, in
which case the resolution would no longer apply and the item would be eligible to
resurface again. Until that consumption step is wired in, this file is
documentation and seed data only — the entries below have no operational effect
on `test-inventory`/`test-fix` runs yet.

---

## Entry Format

Each decision is one `###` entry with a fixed field order:

```
### <short item name>

**Item:** <what test-readiness item this covers — specific enough that a future
  test-inventory/test-fix pass can match its own ambiguous-item fingerprint
  against this entry>
**Decision:** <accept indirect coverage | add unit test | accept as gap | other
  explicit call>
**Rationale:** <why this resolution is correct, not a shortcut>
**Revisit:** <the condition under which this decision should be reconsidered —
  a new call site, a convention change, a triggering event, or a date>
```

Keep **Item** concrete enough to match against a real fingerprint, not a vague
category — a future reader (human or `test-inventory`/`test-fix` itself) should
be able to tell whether a newly-surveyed ambiguous item is "the same thing" as
this entry.

---

## Decisions

### site/src/lib/html-escape.ts — indirect e2e coverage accepted

**Item:** `test-t-073-shipwright` flagged `site/src/lib/html-escape.ts` as an
ambiguous item during test-readiness review — the file has no direct `bun:test`
unit coverage, and it wasn't obvious whether that's a real gap or acceptable
given `site/`'s test conventions.
**Decision:** Accept indirect Playwright e2e coverage instead of adding a
`bun:test` unit file. `html-escape.ts` is exercised end-to-end by
`compare.spec.ts`, `self-hosted.spec.ts`, and `vs-devin.spec.ts`, which already
cover all 3 call sites (`site/src/pages/compare.astro`,
`site/src/pages/self-hosted.astro`, `site/src/pages/vs/devin.astro`).
**Rationale:** `site/` has no unit-test convention — `bunfig.toml` excludes
`site/**` from the root `bun test` scan, and the project's only test layer for
`site/` is Playwright `*.spec.ts` e2e. All 3 call sites of `html-escape.ts` are
already covered by a matching spec file, so a `bun:test` unit file would add a
second, inconsistent test layer for `site/` code without covering anything the
e2e suite doesn't already exercise.
**Revisit:** Revisit if a 4th call site of `html-escape.ts` is added without a
matching `*.spec.ts` covering it, or if `site/` adopts a `bun:test` unit
convention (at which point unit coverage becomes consistent with the rest of the
project and worth adding).
