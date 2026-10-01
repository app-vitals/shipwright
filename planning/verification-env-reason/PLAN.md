# Plan Session: verification-env-reason

**Repo:** app-vitals/shipwright

## Background

LVB-5.1/5.2/5.3 + VEA-1.1 (PR #3810, merged 2026-09-30) built structured `VerificationCheck`
recording — `status: ran_passed | ran_failed | skipped | timed_out`, with `reasonCategory`
(missing_tool / missing_secret / missing_dependency / not_configured / resource_limit /
install_timeout / check_timeout / learned_skip) valid only alongside `skipped`/`timed_out` —
plus an admin UI "Recent Verification Activity" card whose "Environmental issues" section
surfaces exactly those `reasonCategory` rows.

Timeout classification is already automatic: `scripts/run-with-budget.ts` maps exit code 124 to
`timed_out` with `install_timeout`/`check_timeout`. But for any other non-zero exit, `dev-task.md`
Step 8 and its 3 duplicated copies in `patch.md` fall straight through to
`VC_STATUS="ran_failed"; VC_REASON=""` with no judgment step — a missing tool, a missing secret,
or an unreachable dependency (e.g. Postgres not running) is recorded identically to a genuine
code/test failure. The one existing exception is a hardcoded special case: an empty
scoped-lint file list posts `skipped` + `not_configured`.

## Decision (made with Dan, 2026-09-30)

Do **not** build automatic stderr/exit-code pattern matching for this. Rejected as too
speculative — e.g. a pre-flight `command -v` check can't tell you Postgres is unreachable, and
regex-matching stderr risks misclassifying a real failure as environmental. Instead: add an
explicit judgment step to the existing instructions. The agent already has to look at the
failure output to decide what to do about it (fix code vs. can't fix in this environment), so
asking it to also classify the failure at that moment is not wasted work — it's recording a
decision the agent is already making.

## Design

**Business logic (none — command markdown only, no application code changes).**

`dev-task.md` Step 8 (`else` branch, ~line 926-933) and the 3 duplicated copies in `patch.md`
(~line 917, ~1564, ~2284) get a judgment step inserted before the `VC_STATUS="ran_failed"`
default:

- Before finalizing a non-timeout failure, judge whether it happened because of the agent's own
  execution environment (missing tool, missing secret/credential, a missing or unreachable
  dependency such as a database or external service, or a resource limit) rather than a genuine
  code/test defect.
- If environmental: override to `VC_STATUS="skipped"` with `VC_REASON` set to the matching
  category (`missing_tool` | `missing_secret` | `missing_dependency` | `resource_limit`) instead
  of `ran_failed`.
- If unsure, default to `ran_failed` — never guess toward an environmental label defensively.
- The existing empty-scoped-lint → `not_configured` special case is unchanged; this judgment
  step supplements it for the general case, it doesn't replace it.

**Constraint from existing test coverage:** `dev-task.content.test.ts` (~line 1706) and
`patch.content.test.ts` (~line 2700, x3 duplicated sections) assert `ran_failed` never sits
within 120 chars of a literal `reasonCategory: "<value>"` string. The new instruction text must
phrase the override via `VC_REASON` / prose category names rather than a literal
`reasonCategory: "..."` string placed near the word `ran_failed`, so this existing invariant
keeps holding (it remains true: a `ran_failed` row still never carries a `reasonCategory`).

**Views/UX, APIs, DB:** none. No schema, endpoint, or admin UI changes — `verification-check-service.ts`'s
server-side guardrail (`ran_failed` can never carry a `reasonCategory`) is unchanged, and this
task doesn't touch it.

**Test decision:** add one new assertion each to `dev-task.content.test.ts` and
`patch.content.test.ts` (all 3 duplicated `label`-driven sections) confirming Step 8 documents
the environmental-judgment override — checking for the four category names and language
distinguishing this as a judgment call, not automatic detection. No existing test is retired;
this is additive coverage layered onto the existing status-value and reasonCategory-adjacency
assertions, which continue to hold unchanged.

## Breaking Change Safety

No renames, removals, or constraint additions. Pure additive prose in two command files.
Safe to deploy standalone: yes.

## Task

| Task | Depends on | Blocks | HITL |
|------|-----------|--------|------|
| VRC-1.1 | — | — | |

```
[START]
  └─ VRC-1.1: Add environmental-failure judgment step to dev-task/patch Step 8 (no deps)
```

No open cross-session tasks in app-vitals/shipwright were found to be prerequisites for this work.
