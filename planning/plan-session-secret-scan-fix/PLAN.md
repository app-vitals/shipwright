# Plan Session: plan-session-secret-scan-fix

Repo: app-vitals/shipwright

## Input

No `PRODUCT-SPEC.md` existed for this session. The spec is a bug hit live
while running `/shipwright:plan-session`'s own Step 6d (plan-PR creation)
during an unrelated session (`review-bot-detection-fix`): the secret-scrub
gate that's supposed to block a plan-PR commit containing anything
secret-shaped is a permanent no-op.

## Design

`plugins/shipwright/commands/plan-session.md:553` defines `SECRET_PATTERN`
starting with `-----BEGIN`; line 556 runs
`git -C "$WT" diff --cached | grep -qE "$SECRET_PATTERN"`. Because the
pattern string begins with `-`, grep parses it as option flags and errors
(exit 2) instead of scanning, every time. The surrounding
`elif ... grep -qE ...; then` treats any non-zero grep exit code the same
as "no match," so the branch that's supposed to block the commit on a real
secret hit never fires — the scrub gate silently never blocks anything.

This matters specifically because Step 6d's plan-PR commit is the one path
in this command that runs with no human review in `--autonomous` mode — the
comment directly above the check says so explicitly ("no human reviews the
commit before it lands").

Fix: `grep -qE -- "$SECRET_PATTERN"` — the `--` stops grep's option
parsing so the rest of the argument is treated as the pattern, not flags.
Verified locally: without `--`, errors on any input; with `--`, correctly
no-match on benign text and match on an actual PEM private-key-header-shaped
line (confirmed against the fixed gate itself — see note below).

Note: writing out a literal PEM-header-shaped example earlier in this plan's
draft tripped the now-fixed gate on this very commit, which is the gate
correctly doing its job against key-header-shaped text, not a false
positive — the example line has been removed from this doc for that reason.

`plugins/shipwright/commands/plan-session.content.test.ts:506-515` already
has a test confirming the gate exists and runs before the commit
(`"runs a mechanical secret-pattern scan on the staged diff before
committing"`), but it only checks the pattern text is present and
positioned before the commit call — it doesn't check the grep invocation
is well-formed, so it didn't catch this. Add an assertion that the
invocation contains `grep -qE -- "$SECRET_PATTERN"` (with the separator)
so a future edit can't silently drop it again.

**Breaking-change scan:** none — single-file prose/script edit plus a test
addition, no interface change. Safe to deploy standalone: yes.

## HITL Scan

No tasks flagged — no keyword or judgment matches.

## Task Breakdown

| Field | Value |
|---|---|
| ID | PSS-1.1 |
| Title | Fix broken secret-scrub gate in plan-session.md's Step 6d |
| Layer | CLI |
| Branch | `feat/pss-1-1-secret-scan-arg-separator` |
| Hours | 1 |
| Complexity | 2 → `haiku` |
| HITL | no |
| Dependencies | none |

Acceptance criteria:
- `plan-session.md`'s Step 6d secret scan uses `grep -qE -- "$SECRET_PATTERN"`
  (with `--`) instead of `grep -qE "$SECRET_PATTERN"`
- The `⚠ Plan PR not opened — staged plan content matched a secret-pattern
  scan` branch actually fires when the staged diff contains a matching
  pattern (verified by the new test, not just live behavior)
- Test decision: extend `plan-session.content.test.ts`'s existing "runs a
  mechanical secret-pattern scan" test (or add an adjacent one) asserting
  the exact invocation contains `grep -qE -- "$SECRET_PATTERN"` — this is a
  content-test-only change since the script lives in markdown prose, no
  unit test layer applies; no existing tests removed

Dependency map: `[START] → PSS-1.1 (no deps)`

Approved by Dan (Slack), 2026-09-29.
