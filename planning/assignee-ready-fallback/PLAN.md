# Plan Session: assignee-ready-fallback

Repo: app-vitals/shipwright

## Background

`planning/task-store-ready-filters/PLAN.md` (PR #2562, merged) designed `assignee`
filtering under `GET /tasks?ready=true` as a 3-case split by `agentId`/`repos` presence.
Critically: when an agent token has `agentId` but no/empty `repos`, a mismatched
caller-supplied `?assignee=` was designed to be *ignored* (falling back to the token's own
`agentId`), not AND-narrowed against it.

What shipped (PR #2563, refactored by #2569 into a shared helper `matchesTaskFilters()` in
`task-store/src/task-service.ts:95-109`) applies `assignee` as a flat, unconditional AND —
no branching on `repos` presence. `listReady()` and `listBlocked()` both AND this on top of
their existing `agentId`/`repos` OR-union unconditionally, so a repos-absent agent token
passing a mismatched `assignee` gets an always-empty result instead of falling back to its
own tasks.

## Reachability / Impact

Grepped `agent/src`, `admin/`, and every command/doc under `plugins/shipwright/` for real
callers constructing `?ready=true&assignee=` (or the `listReady`/`listBlocked` equivalents):
**none found.** No automated caller in this repo passes an `assignee` filter alongside an
agent token. This is not live automated-traffic-breaking.

It is, however, a real, already-*public* doc/code mismatch: `docs/task-store.md:55` already
states *"Filter by assignee (admin tokens only; agent tokens without repo scope see only
their own tasks)"* — describing the originally-designed fallback behavior, not what shipped.
A human operator following that doc and manually querying with a repos-absent agent token +
a stale/mismatched `?assignee=` value (the doc's own troubleshooting section at
`docs/task-store.md:469` implies this is a plausible manual-debugging path) hits an
always-empty result with no obvious explanation.

**Decision: fix the code (not the docs).** Rewriting the docs to describe the flat-AND
behavior would mean walking back an already-published, more-useful claim in favor of a worse
one. The fix is small and fully contained inside `task-service.ts` — no route/API change,
no breaking change (no live caller depends on today's flat-AND behavior, per the reachability
check above).

## Design

`listReady()` and `listBlocked()` each already compute whether repo-scope applies
(`repos !== undefined && repos.length > 0`, named `useRepoScope` in `listBlocked()`). At that
same call site, when `agentId` is present and repo-scope does **not** apply, strip
`filters.assignee` before calling the shared `matchesTaskFilters()` helper — i.e. build an
effective filters object with `assignee` removed for that one case, and pass it through
otherwise unchanged. `matchesTaskFilters()` itself is untouched: it remains correct as-is for
the admin-token (no `agentId`) case (assignee applies as a standalone filter) and the
repo-scoped case (assignee AND-narrows the OR-union — already correct and already tested).

No `TaskListPostFilters`/`TaskServiceLike` signature changes — this is a behavior-only fix
inside the two methods' existing bodies.

## Tasks

| Task | Title | Depends on | Blocks | HITL | Status |
|---|---|---|---|---|---|
| ARF-1.1 | Fix assignee filter fallback for repos-absent agent tokens | — | — | — | pending |

### ARF-1.1: Fix assignee filter fallback for repos-absent agent tokens in listReady()/listBlocked()

**Description:** `task-service.ts`'s `listReady()` and `listBlocked()` both AND a
caller-supplied `assignee` filter unconditionally on top of their `agentId`/`repos`
OR-union, via the shared `matchesTaskFilters()` helper. When an agent token has `agentId`
but no/empty `repos`, this produces an always-empty result for any mismatched `assignee`
value instead of falling back to the token's own tasks — contradicting both the original
design in `planning/task-store-ready-filters/PLAN.md` and the already-published
`docs/task-store.md:55`.

Fix: in both `listReady()` and `listBlocked()`, when `agentId` is present and repo-scope
does not apply (`repos` undefined/empty), strip `assignee` from the filters object passed
to `matchesTaskFilters()`. Leave `matchesTaskFilters()` itself unchanged — it stays correct
for the admin-token and repo-scoped cases.

**Acceptance Criteria:**
1. `listReady()` and `listBlocked()` both skip applying `filters.assignee` when `agentId` is
   present and `repos` is undefined/empty — falling back to the existing own-assignee match
   — while continuing to AND-narrow `assignee` on top of the `agentId`/`repos` OR-union when
   `repos` is present/non-empty, and continuing to apply `assignee` as a standalone filter
   when `agentId` is absent (admin token). `matchesTaskFilters()` itself is unchanged.
2. Update `planning/task-store-ready-filters/PLAN.md`'s "Known divergence from what actually
   shipped" section to mark this resolved, referencing this task/PR. Explicitly note in the
   PR description that `docs/task-store.md:55` needs no wording change — it already describes
   the now-correct behavior.
3. Test decision: add unit tests to `task-service.unit.test.ts` for both `listReady()` and
   `listBlocked()`: (a) `agentId` present, `repos` absent/empty, mismatched `assignee` →
   returns the token's own tasks, not empty (the regression case for this bug); (b) `agentId`
   present, `repos` absent/empty, `assignee` matching `agentId` → unaffected, still returns
   own tasks; (c) `agentId` present, `repos` non-empty, mismatched `assignee` → still
   AND-narrows as before (regression guard proving the repo-scoped case is untouched); (d)
   `agentId` absent (admin token) with an `assignee` filter is already covered by the
   existing test at `~line 1215` — no change needed there. No integration/smoke test change:
   the bug is entirely inside `task-service.ts`'s in-memory filtering logic, not routing —
   unit coverage against the service directly is sufficient. No existing tests are retired —
   purely additive.

**Dependencies:** none
**Branch:** `feat/arf-1-1-assignee-ready-fallback`
**Layer:** API
**Hours:** 3
**HITL:** none
**Complexity:** 3 (`sonnet`) — 2-3 files (`task-service.ts`, `task-service.unit.test.ts`,
plus the plan-doc update), pure modification of existing code, no new abstraction
**Safe to deploy standalone:** yes — pure bug fix; no live caller depends on today's
flat-AND behavior (confirmed via repo-wide grep), no renames/removals/constraint additions.
