# Deploy-Status Reconciliation — `deploying → deployed` pass

**Date**: 2026-07-19
**Session**: `deploy-status-reconciliation`
**Task**: `DSR-2.1`
**Extends**: `agent/src/pr-state-reconciler.ts` (the same file `DSR-1.1` / PR #1586 extended for the
`pr_open → merged` pass)

## Problem

Tasks are stranded in `deploying` forever when their deploy actually succeeded.

The `deploying → deployed` transition is **not performed by CI**. It is the final step of the
`/shipwright:deploy` command — an agent action (`commands/deploy.md`, `-d '{"status":"deployed",
"deployedAt":"…"}'`). `promote.yml`, the last pipeline stage, has no task-store step at all. So when
an agent's session ends, is interrupted, or the command exits between triggering the promote and
issuing that PATCH, the task is stranded while the code ships normally.

**Observed, not theoretical.** On 2026-07-19 a consuming repo was found with **ten** tasks stuck in
`deploying`, the oldest for two days. Every one had its merge commit on `main` and a successful
*Promote to Prod* run 9–13 minutes after merge. They were corrected by hand.

This is the same class of bug `DSR-1.1` already fixed one status earlier in the lifecycle: an
agent-owned status write that silently doesn't happen. The reconciler is the established answer.

## Blast radius

Deliberately stated, because it is **narrower than it looks** and should not be oversold:

- **Task dependencies are unaffected.** A dependency is satisfied at
  `merged`/`deploying`/`deployed`/`done`/`cancelled`, so stranded tasks never block downstream work.
- `error-resolve` **is** affected — it requires `deployed`/`done` before resolving a linked issue, so
  a stranded task silently keeps issues open.
- Any planning-gate convention that treats only `deployed`/`done` as met will report a doc blocked
  when its gate actually shipped.
- `deployedAt` drives cycle-time metrics; a null on a shipped task corrupts that reporting.

## Design

A fourth pass in `agent/src/pr-state-reconciler.ts`, alongside `reconcilePrState`,
`reconcilePrOpenTasks`, `reconcileOrphanedTasks` and `reconcileReviewState`.

```
export async function reconcileDeployingTasks(deps): Promise<void>
  tasks = listTasksByStatus("deploying")          // existing makeListTasksByStatus helper
  for each task:
    if !task.mergedAt        → skip + log (ambiguous, never guess)
    run = latest successful "Promote to Prod" run for task.repo
    if run && run.createdAt > task.mergedAt:
      PATCH task { status: "deployed", deployedAt: run.createdAt }
```

**Deliberate constraints:**

- **`deployedAt` is the promote run's `createdAt`, never `now()`.** A reconcile-time stamp would
  silently inflate every cycle-time metric it touches — worse than the null it replaces, because it
  looks plausible.
- **The only transition this pass may perform is `deploying → deployed`.** It must never modify a
  task in any other status and never write any other field. A reconciler able to move tasks out of
  `pending`, `blocked` or `cancelled` is a queue-corruption vector.
- **Require `conclusion === "success"`** and a non-null `mergedAt`. Skip and log anything ambiguous.
- **Per-task error isolation** — one lookup failure logs and continues, matching
  `reconcilePrOpenTasks`' existing behaviour.
- Idempotent: a tick with nothing stale performs zero writes; re-running immediately is a no-op.

**New dependency on the deps interface.** The existing `PrStateReconcilerDeps` exposes `ghViewPr`
for a single PR; this pass needs workflow-run data, so it adds one injected method along the same
lines:

```ts
/** List recent workflow runs for a repo, newest first. Throws on lookup failure. */
ghListWorkflowRuns: (
  repo: string,
  workflow: string,
  limit: number,
) => Promise<{ createdAt: string; conclusion: string | null; id: number }[]>;
```

Keeping it injected preserves the file's existing DI shape and keeps the pass unit-testable with no
network.

## Acceptance Criteria

- [ ] A `deploying` task whose merge is followed by a successful promote transitions to `deployed`
      with `deployedAt` set to that run's creation time, not the reconcile time.
- [ ] A `deploying` task with no successful promote after its merge is left untouched.
- [ ] A task in any status other than `deploying` is never modified, under any input.
- [ ] A task with a null `mergedAt` is skipped and logged, never guessed at.
- [ ] A single task's lookup failure does not abort the rest of the batch.
- [ ] A tick with nothing to reconcile performs zero writes; an immediate re-run is a no-op.
- [ ] Registered alongside the existing reconciler passes, on the same sweep interval.

## Testing

Layer: unit — extend `agent/src/pr-state-reconciler.unit.test.ts` with an injected fake task-store
client and a fake `ghListWorkflowRuns`, matching the file's existing test style. No real network, no
`gh` invocation. Cases: transition on a successful post-merge promote; no-op when the only promote
predates the merge; no-op on a non-`success` conclusion; skip-and-log on null `mergedAt`; non-
`deploying` statuses untouched; one failure not aborting the batch.

## Out of scope

- Moving the `deployed` PATCH into `promote.yml`. That would remove the need for this pass entirely
  and is the more complete fix, but it changes the deploy pipeline's contract for every consumer and
  belongs in its own change.
- Any other status transition.
- Backfilling tasks already stranded — those were corrected by hand.
