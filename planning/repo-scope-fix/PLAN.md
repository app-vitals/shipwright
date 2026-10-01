# Plan: repo-scope-fix

## Problem

The Shipwright agent has multiple repo-discovery code paths that enumerate whatever git
clones happen to be present on disk under `repos/` (or `$SHIPWRIGHT_REPOS_DIR`) instead of
consulting the agent's actual configured repo list (`GET /agents/{id}/config`'s `repos[]`
field, synced at runtime into `agent/src/agent-repos-ref.ts`'s `agentReposRef` and exposed
via `getScopedRepos()`/`hasSynced()`). Reported by Dan after observing this in practice;
confirmed via full code + prose audit.

## Technical Design

### Business logic

**Group A — `check-patch.ts` / `check-review.ts` / `check-deploy.ts` (agent/src).**
`buildProductionDeps()` in all three builds an unscoped `allRepos` list from
`resolveAllRepos()` (a filesystem scan of `repos/`) and fans out `gh pr list --repo <repo>`
against every one of those before ever consulting configured scope; filtering to
`getScopedRepos()` happens only after the fetch, and only when `hasScopeSynced()` is true —
leaving zero filtering during any window where the config bundle hasn't synced yet. This
gap is already flagged in a code comment in `pr-state-reconciler.ts:300-308`, which (along
with `pr-census.ts`, `worktree-reaper.ts`, `claim-invariant-reconciler.ts`) was already fixed
(WL-4.4) to intersect with `getScopedRepos()` unconditionally, before any GitHub call.

**Fix:** apply the same unconditional-intersection pattern to all three files — intersect the
filesystem-scanned repo list with `getScopedRepos()` *before* any per-repo `gh` call. Per
decision below, this intersection is now unconditional: delete `hasScopeSynced`/
`hasScopeSynced()` entirely from `CheckPatchDeps`, `CheckReviewDeps`, `CheckDeployDeps`, and
their `buildProductionDeps` opts. Confirmed via grep that no production caller
(`loop-orchestrator.ts`, `index.ts`) passes this field explicitly — but `scripts/hitl.ts`
(lines 1160 and 1170) *does* pass `hasScopeSynced: () => true` into `buildReviewDeps()`/
`buildPatchDeps()`, so removal is **not** self-contained to these 3 files + their own unit
tests: `scripts/hitl.ts` must also be updated (drop the `hasScopeSynced` option from both call
sites) as part of this same change, or it will fail to typecheck once the field is deleted
from `CheckPatchDeps`/`CheckReviewDeps`. `docs/agent-key-files.md`'s `check-review.ts` entry
also documents `hasScopeSynced` as one of `buildProductionDeps()`'s accepted opts and needs a
matching update.

### Shared / config resolution

**Group B — `plugins/shipwright/scripts/check-helpers.ts`.** A second, unrelated
`resolveRepos()`/`resolveRepoDirs()` (no relation to `agentReposRef`) backs the
`shipwright-docs-freshness` and `shipwright-test-readiness` cron prechecks
(`check-docs-freshness.ts`, `check-test-readiness.ts`) and the prose fallbacks in
`research-docs.md` (Step A0) and `test-readiness/SKILL.md` (Step 1) — all pure filesystem
scans of `repos/`, with no scope concept.

**Fix:** add a config-driven resolver to `check-helpers.ts` that calls
`GET $SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/config` (the preCheck subprocess
inherits `process.env` per `cron-handler.ts`, so the credentials are already present) and
intersects the result with the filesystem scan. Wire the two prechecks and the two prose
fallbacks to it.

### Background / crons

**Group C — `entropy-patrol-maintenance` / `security-patrol-maintenance`.** Both crons
(`agent-types/coding/manifest.yaml`) dispatch bare `/shipwright:entropy-scan` /
`/shipwright:security-scan` with no repo argument and no preCheck; neither skill has
multi-repo handling. Observed behavior: the agent improvises repo scope per run.

**Fix:** add a shared preCheck script (reusing Group B's resolver) that emits one section per
configured repo, mirroring `check-docs-freshness.ts`'s convention; wire it into both crons'
`preCheck` field only (their `enabled` values are untouched per explicit decision below);
update `entropy-scan/SKILL.md` and `security-scan/SKILL.md` to consume a precheck-provided
repo list the way `research-docs.md` Step A0 already does, falling back to today's
single-repo (`git remote get-url origin`) behavior only for manual invocation.

### Auto-cloning newly-configured repos (the other direction)

**Group D — `agent/src/index.ts`'s `syncConfig()`.** Groups A-C all gate *acting* on a repo by
whether it's in the agent's configured scope. The reverse gap also exists: `syncConfig()`
(runs every 60s) only does `agentReposRef.set(bundle.repos)` — it updates the in-memory scope
list but never clones anything. Today, adding a repo to an agent's config does nothing until
a human manually clones it, even though `scripts/lib/clone-plan.ts`'s `computeMissingClones()`
already does exactly this planning (pure, already unit-tested) for the manual
`agent-workspace-pull` CLI and `hitl.ts` — it's just never wired into the deployed agent's own
runtime loop.

**Fix:** right after `agentReposRef.set(bundle.repos)`, reuse `computeMissingClones()` against
the real `repos/` dir and `gh repo clone` any repo that's configured but not yet on disk,
mirroring `agent-workspace-pull.ts`'s existing (manual-only) clone pattern. Kept simple per
explicit decision: runs inline/blocking within the sync tick, not backgrounded. A clone
failure (auth hiccup, rate limit, invalid repo) is logged and non-fatal — it's retried
automatically on the next tick since the repo still shows up as missing.

## Decisions

- **Keep the auto-clone step simple.** `syncConfig()`'s new clone step runs inline and
  blocking within the sync tick rather than backgrounded — new repos are added rarely, so a
  one-time clone delaying that tick's env/plugin/tool sync is an acceptable, simple tradeoff.
- **Always fail closed.** Every point in this design that can't confirm the agent's actual
  configured scope — Group A's `getScopedRepos()` intersection, Group B/C's config-API
  resolver — treats "scope unknown" as "zero repos in scope," never as "act on whatever's
  physically on disk." This simplifies Group A (no `hasScopeSynced` branch to maintain) and
  Group B/C's resolver (a config-fetch failure returns an empty list rather than falling back
  to the raw filesystem scan; a precheck that then finds nothing to do behaves exactly like
  its existing "no stale repos this week" no-op path — silent by design, matching Shipwright's
  existing preCheck no-output convention).
- **Cron `enabled` flags untouched.** Group C only changes the `preCheck` field of two
  already-enabled crons; their enabled/disabled state is not part of this change.

## Task Table

| ID | Title | Layer | Hours | Complexity | Model | HITL |
|----|-------|-------|-------|------------|-------|------|
| RSF-1.1 | Scope patch/review/deploy candidate checks to configured repos, fail closed | Background | 3 | 3 | sonnet | |
| RSF-2.1 | Add config-driven repo resolver to plugin check-helpers, fail closed | Shared | 3 | 4 | sonnet | |
| RSF-2.2 | Wire docs-freshness / test-readiness prechecks to the new resolver | Background | 2 | 3 | sonnet | |
| RSF-2.3 | Update prose fallbacks in research-docs.md and test-readiness/SKILL.md | Shared | 2 | 3 | sonnet | |
| RSF-3.1 | Scope entropy/security patrol crons to configured repos | Background | 4 | 4 | sonnet | |
| RSF-4.1 | Auto-clone newly-configured repos on config sync | Background | 3 | 3 | sonnet | |

### RSF-1.1 — Scope patch/review/deploy candidate checks to configured repos, fail closed

Intersect the filesystem-scanned repo list with `getScopedRepos()` *before* any `gh` call in
`check-patch.ts`'s and `check-review.ts`'s `buildProductionDeps()`; consolidate
`check-deploy.ts`'s existing early-filter into the same unconditional pattern. Delete
`hasScopeSynced`/`hasScopeSynced()` entirely from `CheckPatchDeps`, `CheckReviewDeps`,
`CheckDeployDeps`, and their `buildProductionDeps` opts. This also requires updating
`scripts/hitl.ts`'s two call sites (`buildReviewDeps()` and `buildPatchDeps()`, currently at
lines 1160 and 1170) to drop the now-nonexistent `hasScopeSynced: () => true` option, and
updating `docs/agent-key-files.md`'s `check-review.ts` entry, which documents `hasScopeSynced`
as one of `buildProductionDeps()`'s accepted opts.

Acceptance criteria:
- `check-patch.ts`, `check-review.ts`, `check-deploy.ts` query GitHub only for
  `getScopedRepos()` ∩ filesystem-cloned repos — never the raw filesystem list.
- `hasScopeSynced` is removed from all three deps interfaces and their production builders;
  no dead references remain, including in `scripts/hitl.ts`'s `buildReviewDeps()`/
  `buildPatchDeps()` calls.
- `docs/agent-key-files.md`'s `check-review.ts` entry no longer lists `hasScopeSynced` among
  `buildProductionDeps()`'s accepted opts.
- Test decision: update `check-patch.unit.test.ts`, `check-review.unit.test.ts`,
  `check-deploy.unit.test.ts` — remove the fail-open-when-unsynced cases, add/adjust cases
  asserting an empty/never-synced scope yields zero candidates (mirrors
  `pr-state-reconciler.unit.test.ts`'s existing pattern for the same scope semantics).

Dependencies: none. Branch: `feat/rsf-1-1-scope-candidate-checks`. Safe to deploy
standalone: yes.

### RSF-2.1 — Add config-driven repo resolver to plugin check-helpers, fail closed

In `plugins/shipwright/scripts/check-helpers.ts`, add a resolver that calls
`GET $SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/config`, reads `.repos[]`, and
intersects it with the existing filesystem scan. On any failure — missing env, fetch error,
non-2xx response — the resolver returns an empty list (fail closed; no fallback to the raw
filesystem scan).

Acceptance criteria:
- New resolver exported from `check-helpers.ts`, callable by any of the four precheck
  scripts.
- Fail-closed behavior verified: missing `$SHIPWRIGHT_API_URL`/`$SHIPWRIGHT_AGENT_API_KEY`,
  a fetch error, and a non-2xx response all resolve to `[]`, never to the unfiltered
  filesystem scan.
- Test decision: new unit test cases in `check-helpers.unit.test.ts` with an injected fetch
  double (no `mock.module`/`global.fetch`, per repo convention) covering: successful
  intersection, fetch failure → empty, missing env → empty.

Dependencies: none. Branch: `feat/rsf-2-1-config-driven-resolver`. Safe to deploy
standalone: yes.

### RSF-2.2 — Wire docs-freshness / test-readiness prechecks to the new resolver

Update `check-docs-freshness.ts` and `check-test-readiness.ts` to call RSF-2.1's resolver
instead of the raw directory scan.

Acceptance criteria:
- Both prechecks resolve their repo list via the new config-driven resolver.
- A repo that's cloned locally but absent from the agent's configured `repos[]` is excluded
  from both prechecks' output.
- A config-fetch failure results in the precheck's existing clean "no work this tick"
  behavior — no crash, no fallback to the raw filesystem scan.
- Test decision: update `check-docs-freshness.unit.test.ts` and
  `check-test-readiness.unit.test.ts` to inject the new resolver dependency; add a case per
  file proving a filesystem-present-but-unconfigured repo is excluded.

Dependencies: RSF-2.1. Branch: `feat/rsf-2-2-wire-docs-test-readiness`. Safe to deploy
standalone: yes.

### RSF-2.3 — Update prose fallbacks in research-docs.md and test-readiness/SKILL.md

Replace the `for dir in repos/*/` fallback instructions in both files with the config-driven
resolution path from RSF-2.1/2.2.

Acceptance criteria:
- Neither file instructs raw `repos/*` directory iteration as a repo-list source anymore.
- Both reference the config-driven resolver (or the precheck output it backs) as the sole
  repo-list source, consistent with each other.
- Test decision: no existing content test covers this section (checked: none found); add a
  minimal `*.content.test.ts` assertion per file that the fallback text no longer instructs
  raw directory iteration and instead references the configured-repos resolver.

Dependencies: RSF-2.1. Branch: `feat/rsf-2-3-update-prose-fallbacks`. Safe to deploy
standalone: yes.

### RSF-3.1 — Scope entropy/security patrol crons to configured repos

Add a shared preCheck script (reusing RSF-2.1's resolver) that emits one section per
configured repo, mirroring `check-docs-freshness.ts`'s convention. Wire it into
`entropy-patrol-maintenance` and `security-patrol-maintenance` in
`agent-types/coding/manifest.yaml` via the `preCheck` field only — `enabled` values
untouched. Update `entropy-scan/SKILL.md` and `security-scan/SKILL.md` to consume a
precheck-provided repo list the way `research-docs.md` Step A0 already does, falling back to
today's single-repo (`git remote get-url origin`) behavior only for manual invocation.

Acceptance criteria:
- Both crons gain a `preCheck` entry that resolves to the agent's actually-configured repos,
  fail closed on config-fetch failure (cron no-ops that tick, consistent with the Decisions
  section above).
- Both SKILL.md files document consuming a precheck-provided repo list, with manual
  single-repo invocation preserved as a fallback.
- `agent-types/coding/manifest.yaml`'s `enabled` values for both crons are unchanged.
- Test decision: new `*.unit.test.ts` for the shared preCheck script; content-test updates to
  both SKILL.md files asserting the precheck-consumption instructions are present.

Dependencies: RSF-2.1. Branch: `feat/rsf-3-1-patrol-cron-scoping`. Safe to deploy
standalone: yes.

### RSF-4.1 — Auto-clone newly-configured repos on config sync

Right after `agentReposRef.set(bundle.repos)` in `agent/src/index.ts`'s `syncConfig()`, reuse
`scripts/lib/clone-plan.ts`'s `computeMissingClones()` against the real workspace `repos/`
dir, and `gh repo clone` any repo that's configured but not yet cloned locally — mirroring
`scripts/agent-workspace-pull.ts`'s existing (manual-only) clone pattern. Runs inline/blocking
within the sync tick, kept simple per decision above.

Acceptance criteria:
- On every successful config sync, any repo present in `bundle.repos` but absent from the
  local `repos/` dir is cloned automatically via `gh repo clone`.
- A clone failure (auth, rate limit, invalid repo) is logged and does not crash `syncConfig`
  or block subsequent ticks — it is naturally retried next tick since the repo remains
  "missing."
- Already-present repos are left untouched — reuses `computeMissingClones()`'s existing
  skip-if-exists logic rather than re-implementing it.
- Test decision: new unit test cases covering `syncConfig`'s clone step, with injected
  `exists`/`cloneRepo` doubles, asserting: a newly-added repo triggers a clone call with the
  correct destination path; an already-present repo triggers no clone call; a clone failure
  is caught and logged without throwing.

Dependencies: none (independent of Groups A-C — this is the reverse direction of the same
repo/config mismatch). Branch: `feat/rsf-4-1-auto-clone-configured-repos`. Safe to deploy
standalone: yes.

## Dependency Map

```
[START]
  ├─ RSF-1.1 (no deps)
  ├─ RSF-4.1 (no deps)
  └─ RSF-2.1 (no deps)
        ├─ RSF-2.2 (needs 2.1)
        ├─ RSF-2.3 (needs 2.1)
        └─ RSF-3.1 (needs 2.1)
```

```
Task    | Depends on | Blocks        | HITL
RSF-1.1 | —          | —             |
RSF-2.1 | —          | 2.2, 2.3, 3.1 |
RSF-2.2 | 2.1        | —             |
RSF-2.3 | 2.1        | —             |
RSF-3.1 | 2.1        | —             |
RSF-4.1 | —          | —             |
```

## Breaking Change Safety

No renames or removals of any externally-consumed interface. `hasScopeSynced` removal in
RSF-1.1 is internal to `check-patch.ts`/`check-review.ts`/`check-deploy.ts`, their own tests,
and `scripts/hitl.ts`'s two call sites (confirmed via grep — these are the only callers that
reference it; `scripts/hitl.ts` passes it explicitly and must be updated in the same change or
it will fail to typecheck). RSF-4.1 is purely additive (a new step inside an existing
function, reusing an existing pure helper). All 6 tasks: safe to deploy standalone.

## HITL Scan

No tasks require human steps — all changes are code/config/docs shippable through the
normal PR flow; nothing touches `.claude/**`, infra provisioning, or secrets.
