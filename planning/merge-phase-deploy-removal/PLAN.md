# Plan: Replace the deploy phase with a merge phase; simplify task statuses

**Session:** `merge-phase-deploy-removal`
**Repo:** `app-vitals/shipwright`

## Background

Deployment is moving to external automation that marks tasks done once code is live.
`/shipwright:deploy` (Deploy → Canary → Promote orchestration) is therefore redundant. The loop
should merge approved PRs and stop; automation PATCHes the task store afterwards.

## Decisions (from Dan)

- Target statuses: `pending, in_progress, pr_open, approved, merged, deployed, released, done, blocked, cancelled`.
  Remove `deploying` and `deployingAt`. `closed`/`complete` are not statuses (derived filter / route) — untouched.
- `deployed` = service live in an environment. `released` = package flow (tag pushed, chart version or library
  published). Sibling terminals, both reachable from `merged`. `merged` stays a valid terminal for repos that neither
  deploy nor release. No reconcile-to-`done`.
- No `merging` status: the merge phase claims through `/prs/claim` (`phase=merge`), mirroring review and patch.
- The external automation marks tasks by PATCHing the task-store API. Its source of truth is the **PR**, so a
  PR-keyed endpoint (`PATCH /tasks/by-pr`) is added up front rather than a query-then-update double request.
- Remove the stale-deploy reconciler (XPF-5.2). Keep `reconcilePrOpenTasks` (`pr_open → merged`).
- Keep post-merge CI watch + block (deploy.md Step 5c) in `merge.md`. Drop canary-failure revert PR (Step 6) and the
  "Post-merge CI failed" block sweep (Step 2-pre). Drop the busy-repo (active Deploy run) guard.
- `error-resolve` resolves a Sentry issue only on `deployed` or `done` (done = non-PR infra fixes). `released` does
  not resolve: publishing a library does not change what a running service executes until a consumer deploys.
- Remove the `phaseMethodology["deploy"]` override key with the command.

## Design

**Task store.** `released` + `releasedAt` mirror `deployed`/`deployedAt`; `released` joins `CLOSED_STATUSES` (satisfies
dependencies in `ready.ts`/`blocked-by.ts`). `PrPhase` gains `merge`; `PullRequest` gains `readyForMergeAt` and FIFO
aging becomes `COALESCE(readyForReviewAt, readyForPatchAt, readyForMergeAt, readyForDeployAt)` during the
transition. `PATCH /tasks/by-pr` body `{repo, prNumbers[], status: deployed|released, at?}` transitions every task
linked to those PRs that is currently `merged`, in one transaction with TaskEvent rows, idempotent for tasks already
at the target status, and reports `{updated, unchanged, skipped}`.

**Agent loop.** `check-merge.ts` derives from `check-deploy.ts` (approval, green CI, authorship, hitl/blocked,
bundle completeness, claimedBy) without the busy-repo guard; candidates are tagged `phase: "merge"`. The orchestrator
maps `merge → /shipwright:merge`, adds a `shipwright-merge` child cron row (seeded disabled) and a toggle, and
includes `merge` in the pre-claim and auto-resume paths.

**merge.md.** Accepts `[preclaim:...]`, claims `phase=merge`, releases on every exit, and after a successful squash
merge watches CI on the merge SHA (10 minutes, 30s polls). Failure → every linked task `blocked` with a reason naming
the run; PR record `blocked` when there is no task. Green or timeout → tasks stay `merged` (automation owns what
happens next).

**Rollout (add → migrate → remove).** (1) additive code; (2) one HITL task flips all agents from deploy to merge;
(3) cleanup: reconciler, deploy phase, command and references, consumers off `deploying`, then the enum/column drop.

## Tasks

| ID | Title | Depends on | HITL |
|---|---|---|---|
| MPD-1.1 | feat: add released status, merge PR phase and readyForMergeAt | — | |
| MPD-1.2 | feat: add PATCH /tasks/by-pr to mark merged tasks deployed or released | 1.1 | |
| MPD-1.3 | feat: add check-merge candidate provider | 1.1 | |
| MPD-1.4 | feat: wire the merge phase into the loop and cron defaults | 1.3 | |
| MPD-1.5 | feat: merge command pre-claim, phase=merge and post-merge CI watch | 1.1 | |
| MPD-1.6 | feat: support released in the admin UI, metrics and error-resolve gating | 1.1 | |
| MPD-2.1 | chore: disable deploy and enable merge on all agents | 1.2, 1.4, 1.5, 1.6 | ⚠ HITL |
| MPD-3.1 | refactor: remove the stale-deploy reconciler | 2.1 | |
| MPD-3.2 | refactor: remove the deploy phase from the loop | 2.1 | |
| MPD-3.3 | chore: delete the deploy command and scrub plugin references | 3.2 | |
| MPD-3.4 | refactor: move consumers off deploying, deployingAt and the deploy PR phase | 3.1, 3.2 | |
| MPD-3.5 | feat: drop deploying, deployingAt, PrPhase deploy and readyForDeployAt | 3.4 | |
| MPD-3.6 | docs: update docs and site for the new status flow | 3.3, 3.5 | |

```
1.1 ─┬─ 1.2 ────────────┐
     ├─ 1.3 ─ 1.4 ──────┼─ 2.1 (HITL) ─┬─ 3.1 ─┐
     ├─ 1.5 ────────────┤              └─ 3.2 ─┼─ 3.4 ─ 3.5 ─┐
     └─ 1.6 ────────────┘                3.2 ─ 3.3 ─────────┴─ 3.6
```

## Breaking Change Safety

- `deploying`/`deployingAt`/`PrPhase.deploy`/`readyForDeployAt` removal is add → migrate → remove: 1.x adds the
  replacements, 3.1–3.4 stop every producer and consumer, 3.5 drops them. 3.5 must record live counts of
  `status=deploying` tasks and `phase=deploy` PR claims (via the API) in its PR, and its migration maps
  `deploying → merged` and clears deploy-phase claims.
- `shipwright-deploy` cron rows are disabled by 2.1 before any code is deleted.
- `deploy.md` removal (3.3) happens only after the loop no longer dispatches it (3.2).

## Consequences accepted

- Canary-failure revert PRs and the stale "Post-merge CI failed" block sweep are gone; a CI-blocked task is
  cleared by `/shipwright:unblock`.
- Repos that neither deploy nor release never get Sentry issues auto-resolved by `error-resolve` from `merged`.
