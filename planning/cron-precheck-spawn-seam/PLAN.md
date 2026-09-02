# Plan: cron-precheck-spawn-seam

## Background

PR #3006 (SSB-1.1, merged 2026-09-01) failed CI's `test:coverage` step 6/6 times, each
time on a *different* unrelated pre-existing flake (worktree-reaper, config env vars,
cron precheck) rather than the same one repeatedly. Root-caused live during this session
against CI run 33549885704 (`gh run view --log-failed`): the failure was two tests in
`agent/src/cron-handler.smoke.test.ts`'s "handleCronRequest — preCheck" describe block —
`preCheck inherits runtime process.env mutations` and `runs preCheck with cwd = workspace`.

## Root cause

Two related classes of test-isolation flakiness exist in this repo:

1. **In-process `process.env` mutation races** (Bun runs all test files in one shared
   process). Already tracked and fixed: TIF-1.1 (`check-review.unit.test.ts`, merged) and
   TIF-1.2 (`pr-state-reconciler.unit.test.ts`, merged PR #2629, 2026-08-13). Neither
   touches `cron-handler.smoke.test.ts`.
2. **Real-subprocess-spawn timing under CI load** — the actual cause here.
   `cron-handler.ts`'s preCheck runner hardcodes `Bun.spawn(["bun", scriptPath], ...)`
   with no injection seam, so `cron-handler.smoke.test.ts`'s preCheck describe block is
   forced to spawn ~10 real `bun` child processes per run. Under CI resource contention
   this occasionally produces late/truncated output against Bun's default per-test
   timeout.

A full audit of every other real-subprocess call site in `agent/src` found this is the
**only** gap — `setup.ts` (`ExecFn`/`defaultExec`), `claude.ts` (`spawner: typeof Bun.spawn
= Bun.spawn`), and `setup-github-auth.ts` (injected `spawnSync`) already use a DI seam;
`check-helpers.ts`'s `ghJson`/`ghRun`/`ghGraphql` and `pr-state-reconciler.ts`'s
`removeWorktree` are never called directly in tests (always faked via injected deps).

Separately, these tests are misclassified under this repo's test-layer convention —
`*.smoke.test.ts` is defined as HTTP route contracts via in-process `app.request()`, not
subprocess-spawning behavior — so the fix also relocates them to their correct layer.

## Design

Add a `spawner` field to `CronHandlerDeps` mirroring `claude.ts`'s exact existing pattern
(`spawner?: typeof Bun.spawn`, defaulting to real `Bun.spawn` in production). Use it at
the preCheck `Bun.spawn` call site (`cron-handler.ts:262`). Move the preCheck-behavior
tests out of `cron-handler.smoke.test.ts` into a unit test file, injecting a fake spawner
instead of touching real subprocesses. Keep exactly one real-spawn integration test to
verify the actual `Bun.spawn` wiring end-to-end.

## Tasks

| Task | Depends on | Blocks | HITL |
|------|-----------|--------|------|
| CPS-1.1 | — | — | |

### CPS-1.1 — Add spawner injection seam to cron-handler preCheck and de-flake its tests

**Layer:** Background
**Branch:** `feat/cps-1-1-cron-precheck-spawn-seam`
**Hours:** 3
**Complexity:** 3 (`sonnet`)
**Safe to deploy standalone:** yes — additive optional field, default preserves current
production behavior.

**Description:** `CronHandlerDeps` (agent/src/cron-handler.ts:111) gains an optional
`spawner?: typeof Bun.spawn` field, mirroring the existing pattern in `claude.ts:241`
(`spawner: typeof Bun.spawn = Bun.spawn`). The preCheck runner's `Bun.spawn(["bun",
scriptPath], ...)` call (cron-handler.ts:262) uses `deps.spawner ?? Bun.spawn` instead of
calling the global directly.

**Acceptance criteria:**
- `CronHandlerDeps` has an optional `spawner` field; the preCheck runner uses it (falling
  back to real `Bun.spawn`) instead of calling `Bun.spawn` directly. No other
  `CronHandlerDeps` consumer (`index.ts`, `health.ts`) needs changes — the field is
  optional and the default preserves current behavior.
- Test decision: move the ~10 preCheck-behavior tests currently in
  `cron-handler.smoke.test.ts`'s "handleCronRequest — preCheck" describe block into
  `agent/src/cron-handler.unit.test.ts` (create if it doesn't exist), rewritten to inject
  a fake `spawner` that returns canned stdout/stderr/exit code instead of spawning a real
  `bun` process — this removes the CI-timing dependency that caused PR #3006's repeated
  CI failures. Delete the moved tests from `cron-handler.smoke.test.ts` — no duplicates.
  Keep exactly one true end-to-end test that spawns a real subprocess (in
  `cron-handler.integration.test.ts`) verifying the real `Bun.spawn` wiring still works.
- `task ci` passes clean.
