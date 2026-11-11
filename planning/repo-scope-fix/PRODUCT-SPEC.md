# Product Spec: Scope repo discovery to agent config, not workspace filesystem

## Problem

The Shipwright agent has multiple independent repo-discovery code paths that enumerate
whatever git clones happen to be present on disk under `repos/` (or `$SHIPWRIGHT_REPOS_DIR`)
instead of consulting the agent's actual configured repo list — the `repos[]` field returned
by `GET /agents/{id}/config`, already synced at runtime into `agent/src/agent-repos-ref.ts`'s
`agentReposRef` and exposed via `getScopedRepos()`/`hasSynced()`.

This matters because the workspace filesystem and the agent's configured repo list can
diverge in both directions: a repo manually cloned into `repos/` for research (not actually
assigned to the agent) gets treated as fully in-scope, while a newly-assigned repo not yet
reflected on disk gets silently skipped. Reported by Dan (App Vitals cofounder) after
observing this in practice.

## Why now

Confirmed via a full code + prose audit (below). One instance is an already-acknowledged gap:
`agent/src/pr-state-reconciler.ts` (~line 300-308) has a code comment admitting that
`check-deploy.ts`, `check-review.ts`, and `check-patch.ts` still call the unscoped
`resolveAllRepos()` where `pr-state-reconciler.ts` itself, `claim-invariant-reconciler.ts`,
`worktree-reaper.ts`, and `pr-census.ts` were already fixed (WL-4.4) to loop over
`getScopedRepos()` instead. This spec asks to finish that fix and extend the same principle
everywhere else it's missing.

## Confirmed instances

### 1. [Bug, highest priority] Unscoped GitHub queries in patch/review/deploy candidate checks

`agent/src/check-helpers.ts`'s `resolveAllRepos()`/`scanReposDir()` scans `workspace/repos/`
on disk (reading each clone's `.git/config` for its remote origin) to build an unscoped
`allRepos` list. That list — not `getScopedRepos()` — is what `check-patch.ts` (~line 654) and
`check-review.ts` (~line 797) actually use to query GitHub (`gh pr list --repo <repo>`): both
filter down to `getScopedRepos()` only **after** fetching, and only when `hasScopeSynced()` is
true. When scope has never successfully synced, there is no filtering at all — every repo
physically present in the workspace is treated as fully in-scope for patch/review candidate
selection, which drives real write actions (pushing fixes, posting reviews).

`check-deploy.ts` (~lines 212-216) was narrower: it already intersected `deps.repos` with
`getScopedRepos()` into `scopedRepos` *before* its GitHub fetch calls (busy-repo lookup and
`listOpenPrs`), so once scope had synced it did not query GitHub for every repo on disk. Its
only gap was the same fail-open edge as the other two, scoped down to one window: when
`hasScopeSynced()` was false, it fell back to the full unfiltered `deps.repos` list rather
than filtering — so only the pre-first-sync period (not steady-state operation) was exposed.

**Fix:** apply the same pattern already used in `pr-state-reconciler.ts`,
`claim-invariant-reconciler.ts`, `worktree-reaper.ts`, and `pr-census.ts` (WL-4.4) — query
GitHub only for `getScopedRepos()`, never the raw filesystem list. Decide during planning
how these three should behave when `hasScopeSynced()` is false (e.g. skip the tick and log,
rather than failing open to "every repo on disk is in scope").

**Status (2026-10-01): already complete.** This bug was independently fixed and merged to
`main` via PR app-vitals/shipwright#3841 (merged 2026-10-01T07:05:46Z — an ancestor of this
plan PR's base), before this spec's tasks were seeded into the task store. Confirmed on
current `main`: `hasScopeSynced` no longer exists anywhere in `check-patch.ts`,
`check-review.ts`, or `check-deploy.ts` — the `getScopedRepos()` intersection in all three is
now unconditional, with no pre-sync fallback window remaining (see PLAN.md's RSF-1.1 Status
note). This section is retained for historical context only; do not treat it as live,
unresolved work.

### 2. Filesystem-only repo resolver behind docs-freshness / test-readiness prechecks

`plugins/shipwright/scripts/check-helpers.ts`'s `resolveRepos()`/`resolveRepoDirs()`/
`scanReposDirWithPaths()` is a second, separate implementation (distinct package from #1,
no relation to `agentReposRef`) with no scope concept at all: scan `repos/` → fall back to
scanning `$SHIPWRIGHT_REPOS_DIR` → empty. This is the sole repo-discovery mechanism behind:

- `plugins/shipwright/scripts/check-docs-freshness.ts` (the `shipwright-docs-freshness`
  cron's preCheck)
- `plugins/shipwright/scripts/check-test-readiness.ts` (the `shipwright-test-readiness`
  cron's preCheck)

Documented today as intentional (`docs/agent-ops.md`), but it still can't distinguish a repo
actually assigned to the agent from a stray one sitting in the workspace for some other
reason.

**Fix:** source this resolver's repo list from the agent's config (e.g. the same
`GET /agents/{id}/config` call `commands/*.md` already use elsewhere) and use it to filter —
or replace outright — the raw directory scan.

### 3. Prose fallbacks that iterate `repos/*` directly

- `plugins/shipwright/commands/research-docs.md` — Step A0's documented fallback for manual
  invocation is literally:
  ```bash
  for dir in repos/*/; do
    [ -d "$dir/.git" ] && basename "$dir"
  done
  ```
- `plugins/shipwright/skills/test-readiness/SKILL.md` — Step 1 has the identical fallback
  pattern (with an added `docs/test-readiness` directory check).

**Fix:** resolve against the agent's configured repos instead of raw directory iteration,
consistent with whatever mechanism #2 lands on.

### 4. [Gap] No config-driven multi-repo handling for entropy/security patrol crons

`entropy-patrol-maintenance` and `security-patrol-maintenance`
(`agent-types/coding/manifest.yaml`) dispatch bare `/shipwright:entropy-scan` /
`/shipwright:security-scan` prompts — no repo argument, no preCheck. Neither
`plugins/shipwright/skills/entropy-scan/SKILL.md` nor `skills/security-scan/SKILL.md` has any
multi-repo handling (`entropy-scan` never addresses repo scope at all; `security-scan` only
ever operates against "the current repo" via `git remote get-url origin`). Per prior
observation, the agent ends up improvising — scanning whichever repos happen to be physically
present rather than its full configured set, and inconsistently across runs.

**Fix:** give these two crons the same config-driven, explicit multi-repo iteration pattern
proposed for docs-freshness/test-readiness in #2/#3, sourced from the agent's configured
repos — not the filesystem.

## Out of scope (audited, confirmed not part of this problem)

- `scripts/agent-workspace-pull.ts` — clones strictly from the fetched `bundle.repos`, never
  scans a local directory to decide what to clone. Already correct.
- `scripts/hitl.ts` — local human-in-the-loop dev CLI with no accounts-service connection by
  design; its own comment notes it has no config bundle to sync scope from. Different
  execution context, not the deployed agent path. Caveat: "no changes" refers to hitl.ts's
  scope *semantics* (it intentionally keeps treating every cloned repo as in-scope). It still
  took a purely mechanical, signature-following edit as a side effect of RSF-1.1 — deleting
  `hasScopeSynced` from `CheckPatchDeps`/`CheckReviewDeps` required dropping the now-nonexistent
  `hasScopeSynced: () => true` option from this file's two `buildReviewDeps()`/
  `buildPatchDeps()` call sites to keep it typechecking. Already done as part of RSF-1.1 (PR
  app-vitals/shipwright#3841).
- `agent/src/worktree-reaper.ts`'s directory read, `process-tree-kill.ts`, `piper-voice.ts`,
  `setup.ts`, `admin/src/agent-type-manifest-loader.ts`,
  `scripts/check-competitive-freshness.ts`, `scripts/check-config-docs.ts`,
  `plugins/shipwright/scripts/check-banned-strings.ts`,
  `plugins/shipwright/scripts/check-learn-dream.ts` — genuinely repo-agnostic or unrelated
  filesystem scans (voice files, agent-type manifests, worktree names already filtered
  upstream, single-already-known-repo checks, learning-dream project dirs). Not repo-list
  discovery and should not be touched.

## Goal

Every place the agent decides "which repo(s) do I act on" resolves against the agent's
actual configured repo list, never against what happens to be cloned in the local workspace.
Filesystem clones remain the mechanism for *accessing* an already-known-assigned repo's code
— never the mechanism for *deciding which repos are assigned*.
