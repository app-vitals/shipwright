# Plan: loop-repo-rescan (prefix LRR)

Repo: app-vitals/shipwright

## Problem
`syncConfig()` (RSF-4.1) auto-clones newly configured repos into `repos/` every 60s, but the
PR-phase consumers snapshot the filesystem repo list once at construction:
- `check-review.ts` (buildProductionDeps: `const allRepos = resolveAllRepos(...)`)
- `check-patch.ts` (same)
- `check-deploy.ts` (same, stored as `deps.repos: string[]`)
- `pr-state-reconciler.ts` (two builders, stored as `deps.repos: string[]`; `index.ts` memoizes the deps with `??=`)

`createProductionLoopOrchestrator` builds review/patch/deploy deps once for the process lifetime, so
a repo cloned after process start is invisible to review, patch, deploy and PR reconciliation until
the agent restarts. Only the scope filter (`agentReposRef`) is live. Dev-task candidates come from
the task store, so the failure shows only on PR phases. Observed 2026-10-10: app-vitals/how-to-factory
cloned 18:40, PRs #2/#3 never became candidates (admin work-queue snapshot empty).

## Design
Resolve the repo list at call time, not at construction. Expected, simplest shape, no getter tricks:
- check-review / check-patch: `allRepos` is a local; evaluate `resolveAllRepos(workspacePath)` inside the per-call closures (`listOpenPrs`, `getScopedAllRepos`, and the `allRepos[0]` fallback in check-patch).
- check-deploy and both pr-state-reconciler deps interfaces: replace the `repos: string[]` field with `getRepos: () => string[]`; builders return `() => resolveAllRepos(workspacePath)`; consumers call `deps.getRepos()`. Update test fixtures (~30 mechanical lines).
- Scan cost is a read of each clone's `.git/config` (~10 clones) per candidate-collection call.
- Unreadable `repos/` still yields `[]`, unchanged.
- Test approach: real temp workspace + `.git/config` remote written AFTER deps are built; assert the next call sees the repo. No `mock.module()` / global fetch.

Breaking-change scan: `PrStateReconcilerDeps.repos`, `PrReviewStateReconcilerDeps.repos`, `CheckDeployDeps.repos`
are internal agent interfaces; only callers are the builders in the same files and tests. Renaming is
done atomically in each task (all consumers updated in the same PR). Safe to deploy standalone: yes.
HITL scan: none.

## Tasks
| ID | Title | Deps | Model |
|---|---|---|---|
| LRR-1.1 | fix: resolve repo list per call in check-review and check-patch | — | sonnet |
| LRR-1.2 | fix: replace CheckDeployDeps.repos with getRepos() | — | sonnet |
| LRR-1.3 | fix: replace reconciler deps repos with getRepos() | — | sonnet |
| LRR-1.4 | docs: say new repos are picked up without a restart | 1.1, 1.2, 1.3 | haiku |

```
[START]
  ├─ LRR-1.1 ─┐
  ├─ LRR-1.2 ─┼─ LRR-1.4
  └─ LRR-1.3 ─┘
```

## Decision Log
- getRepos() function over a property getter: Dan's direction, expected and simplest, no shortcuts.
- Three PRs instead of one: review/patch providers, deploy provider and reconcilers review separately; no shared helper needed.
