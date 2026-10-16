# Agent runtime / coding dependency audit

**Date**: 2026-10-16 · **Commit audited**: `07e79159e` (origin/main at the time) · **Method**: static import graph of the non-test `.ts` files in `agent/src` (77 files), plus targeted greps outside `agent/`. Read-only; no build or tests were run. See [`CONTEXT.md`](./CONTEXT.md) for why this was done.

**Caveat**: files were classified coding vs runtime by a filename pattern, so the boundary is a judgment, not ground truth. Judgment calls: `agent-repos-ref`, `gh-*`, `github-*`, `sync-config-clone`, `work-queue-reporter`.

## Classification

Coding pattern: `check-*`, `loop-*`, `work-*`, `pr-*`, `patch-*`, `claim-invariant*`, `worktree-reaper`, `cleanup-merged*`, `owner-routing`, `review-author*`, `patch-author*`, `allow-self-review*`, `gh-*`, `github-*`, `setup-github*`, `agent-repos*`. Everything else is runtime.

| | Files | Source LOC | Test files | Test LOC |
|---|---|---|---|---|
| Coding | 30 | ~12.4k | 35 | ~29.7k |
| Runtime | 47 | ~10.8k | 56 | ~25.8k |

**Coding (30):** agent-repos-ref, allow-self-review-ref, check-deploy, check-dev-task, check-helpers, check-patch, check-plan, check-review, claim-invariant-reconciler, cleanup-merged-worktrees-ref, gh-owner-resolver, gh-token-files, github-app-auth, github-auth-deps, github-auth-startup, github-installations, github-installations-reporter, loop-cron-classifier, loop-jobs-ref, loop-orchestrator, patch-author-allowlist-ref, patch-outcome-check, pr-census, pr-origin-backfill, pr-state-reconciler, review-author-allowlist-ref, setup-github-auth, work-queue-reporter, work-selector, worktree-reaper.

**Runtime (47):** agent-account-status-ref, agent-policy-backfill, agent-slack-membership-ref, agent-trial-expiry-ref, anthropic-federation-guard, browser, chat-poller, chat-token-reporter, claude, claude-version, cleanup-after-days-ref, cli-args, clock, config, context-stamp, cron-failure-reporter, cron-handler, cron-run-reporter, crypto, cutover-validate, entrypoint, entrypoint-main, errors, format, health, http-chat-service-client, index, log-prefix, markers, piper-voice, pricing, process-tree-kill, progress-milestones, run-telemetry, sessions, setup, shipwright-config-client, shipwright-runtime-client, slack, slack-progress, slack-startup, slack-thread-status-tracker, startup-dm, sync-config-clone, test-env, users, voice.

## Findings

### 1. Runtime → coding edges (21): almost all `index.ts`
```
index -> agent-repos-ref, allow-self-review-ref, check-helpers, claim-invariant-reconciler,
         cleanup-merged-worktrees-ref, github-auth-deps, github-auth-startup,
         github-installations-reporter, loop-cron-classifier, loop-jobs-ref,
         loop-orchestrator, patch-author-allowlist-ref, pr-census, pr-state-reconciler,
         review-author-allowlist-ref, setup-github-auth, work-queue-reporter, worktree-reaper
entrypoint-main -> github-auth-deps, setup-github-auth
agent-policy-backfill -> check-helpers
```
`index.ts` (~1k lines) is the composition root: it hardcodes the coding periodic work (PR-state reconciler + review-state pass, worktree reaper, claim-invariant reconciler, PR census, loop orchestrator, work-queue reporter) and GitHub auth setup. Decoupling means turning this into runtime boot plus registered extensions.

### 2. Coding → runtime edges: few, stable, benign
Imported by coding files: `clock` (9 files), `cleanup-after-days-ref`, `claude`, `context-stamp`, `cron-failure-reporter`, `cron-handler`, `cron-run-reporter`, `markers`, `run-telemetry`. The dependency direction (coding → runtime services) is the desired one.

### 3. `check-helpers.ts` is the one mixed file
1.5k lines, 11 importers (the highest fan-in of any coding module). It contains:
- generic `gh` CLI helpers (`ghJson`, `ghRun`, `ghGraphql`, `getCurrentUser`), also used by `index.ts`
- six policy parsers (`parseAllowSelfReview`, `parseAutoPostReviews`, `parseMinConfidence`, `parseMaxFindings`, `parseCleanupMergedWorktrees`, `parseCleanupAfterDays`) plus `read*` wrappers, used by `agent-policy-backfill`
- coding-only logic: review-state classification, task-store/PR query clients, candidate-id helpers, skip/bundle queries, workspace repo resolution

### 4. Tests are cleanly owned
91 test files. Only 9 import across the boundary, and nearly all of those only import `clock`: check-plan, pr-census, pr-state-reconciler, check-dev-task, github-app-auth.integration, worktree-reaper (clock); check-helpers.unit (cleanup-after-days-ref); loop-orchestrator unit/integration (claude, clock, context-stamp, cron-run-reporter, run-telemetry). Tests can move with their modules unedited.

### 5. Runtime ↔ admin: type-only, no cycle
`agent` depends on `@shipwright/admin` (workspace) only via `import type` (`AgentPlugin`, `AgentCronJob`, `AgentConfigResponse`) in `cutover-validate`, `entrypoint`, `shipwright-config-client`, `setup`, `shipwright-runtime-client`. No file in `admin/`, `lib/`, `task-store/` or `chat/` imports from `agent/`. (`agent-policy-backfill` additionally reaches the admin Prisma client; see its header comment.)

### 6. External references to `agent/` internals
- `agent/Dockerfile`: `COPY agent/ ./agent/`, bundle-check `find agent/src -name "*.ts" | xargs bun build`, `ENTRYPOINT ["bun","run","/app/agent/src/entrypoint-main.ts"]`, `PATH` includes `/app/agent/scripts/bin`, voices under `/app/agent/voices`.
- `.github/workflows/ci.yml` asserts entrypoint behavior; `sync-plugin-version.yml` references `installPlugins()` in `setup.ts`.
- `plugins/shipwright/tsconfig.json` includes `../../agent/src`.
- Coding scripts importing agent internals (move with coding): `scripts/hitl.ts` (work-selector, patch-outcome-check, check-review, check-patch, check-helpers, plus runtime setup/claude); `plugins/shipwright/scripts/diagnose-review-candidacy.ts` (check-helpers, check-review, check-patch). `scripts/agent-workspace-pull.ts` imports runtime `setup` and `shipwright-runtime-client`.
- Coding check scripts import plugin scripts via relative paths (`../../plugins/shipwright/scripts/compute-unaddressed-findings.ts`, `is-ci-green.ts`, `login-identity.ts`).
- No Helm chart or other YAML/TOML hardcodes `agent/src`.

### 7. Templates and type resolution
`agent-types/coding/manifest.yaml` sets `identity.templatesDir: agent/workspace/`, but only the schema (`admin/src/agent-type-registry.ts`) and `plugins/shipwright/scripts/prompt-audit/inventory.ts` reference it. `agent/src/setup.ts` reads templates relative to its own source file. Open: whether the runtime process knows its agent type at boot.

## Not audited
- `admin/` coding-shaped code (`agent-work-queue*`, `agent-phase-methodology`, patch-author allowlist).
- `agent/scripts/` and `agent/workspace/` contents beyond what is listed above.
- Boot-order dependencies inside `index.ts` (which of the 6 periodic passes assume ordering, which share state) — the first thing an extension-seam task must establish.
- Whether the build and full test suite pass on current main (not run).

## Reproduce
Import graph: for each non-test `agent/src/*.ts`, collect `from "./x"` / `import("./x")` specifiers that resolve to another file in the directory, plus `@shipwright/*` and `../` specifiers as external. Classify with the filename pattern above, then list edges that cross the boundary in each direction and per-test-file imports that cross it.
