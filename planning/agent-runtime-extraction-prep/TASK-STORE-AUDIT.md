# Task-store platform / coding audit

**Date**: 2026-10-20 · **Commit audited**: `13bdb966e` (origin/main) · **Method**: read `task-store/prisma/schema.prisma`, `statuses.ts`, `ready.ts`, `blocked-by.ts`, `task-service.ts` (claim/heartbeat/complete/fail/release/update/listReady), the transition-diff and reaper modules, route inventories for all five routers, and import/consumer greps across the repo. Read-only; no build or tests were run. Companion to [`ADMIN-AUDIT.md`](./ADMIN-AUDIT.md) (admin, `lib`, `agent-types/`) and [`../agent-types-decoupling/AUDIT.md`](../agent-types-decoupling/AUDIT.md) (agent runtime).

**Why**: Dan's call (2026-10-20): task-store has a **work-item portion that is platform**; most of it is coding-specific. This audit finds where that line runs, how entangled it is, and what the platform actually needs from task-store today.

**Caveat**: the work-item base does not exist as a code unit today. It is a layer that has to be carved out of `TaskService`, `ready.ts`, the `Task` model and the reaper. Classification below is judgment from reading, marked **(judgment)** where it is not clear-cut.

## Headline

1. **The platform needs very little of task-store today.** `agent/src/runtime` makes no task-store calls (only two comments in `cron-handler.ts`). The platform's whole dependency is **admin provisioning**: minting and revoking per-agent tokens (`task-store-provisioning-client.ts`) and injecting `SHIPWRIGHT_TASK_STORE_URL/TOKEN` into the agent Deployment (`agent-manifest.ts`). Every real consumer of tasks is coding: `agent/src/coding/*`, the shipwright plugin (about 40 commands/skills/references call the HTTP API), `scripts/hitl.ts`, `metrics`, `mcp-server`, and the admin task/PR/session views.
2. **The generic core is real but small, and well-shaped.** Claim, heartbeat, complete, fail (block), release, skip/spin protection, unblock, dependencies, `hitl`, an audit trail, tenant scoping and a `metadata` JSON escape hatch are already implemented as plain status transitions that name no PR, branch or repo. Roughly 30–35% of the service logic is this core.
3. **The coding half is larger and mostly separable by file**: `PullRequest`, `PrFinding`, `PullRequestEvent`, `VerificationCheck` (4 models, about 4.4k lines of service+route code) plus the `Task` columns for repo/branch/PR/CI/merge/deploy/simplify.
4. **Entanglement is concentrated in five places** (section 3), not spread everywhere. None is hard individually; together they are why this is an audit and not a move.
5. **Status lifecycle is the sharpest design question.** One `TaskStatus` enum mixes generic (`pending`, `in_progress`, `blocked`, `done`, `cancelled`) with the coding pipeline (`pr_open`, `approved`, `merged`, `deploying`, `deployed`), and `statuses.ts`, `ready.ts`, `blocked-by.ts`, `session-rollup.ts`, the admin UI and the plugin all key off it.

## 1. Data model (Prisma, one schema, 7 models)

| Model | Class | Notes |
|---|---|---|
| `Task` | **mixed** | ~70 columns, see below |
| `TaskEvent` | platform | field-level audit rows `(taskId, field, old, new, actor, method, at)`; generic. The *audited-field list* (`TASK_AUDITED_FIELDS`) is where coding columns leak in |
| `TaskToken` | platform | hashed bearer tokens, `agentId` null = admin; used by auth and by admin provisioning |
| `Session` | platform-ish **(judgment)** | `(accountId, slug)` grouping with archive state; the grouping is generic, the *rollup* over it is coding-flavoured (section 2) |
| `PullRequest`, `PrFinding`, `PullRequestEvent` | coding | PR review/patch/deploy lifecycle, findings |
| `VerificationCheck` | coding | FK to `Task`; CI/verification results |

**`Task` columns by class**

- **Work-item core (platform)**: `id`, `accountId`, `title`, `description`, `status`, `kind`, `session`, `source`, `assignee`, `priority`, `type`, `note`, `dependencies`, `acceptanceCriteria`, `hitl`, `blockedAt`, `blockedReason`, `startedAt`, `completedAt`, `cancelledAt`, `claimedBy`, `claimedAt`, `heartbeatAt`, `agentHint`, `skipCount`, `lastSkippedAt`, `lastSkipReason`, `metadata`, `createdAt`, `updatedAt`, and the cost/usage columns `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `costUsd`, `effortLevel`, `model`, `complexity`, `hours` (**judgment** on cost and model: useful for any agent type, but today only the coding loop writes them).
- **Coding**: `repo`, `branch`, `pr`, `prUrl`, `prCreatedAt`, `mergedAt`, `mergeCommit`, `deployingAt`, `deployedAt`, `ciFixAttempts`, `issue`, `layer`, `simplifyTotal/Dry/DeadCode/Naming/Complexity/Consistency`, `coverageDelta`.
- **Indexes** are on `status`, `session`, `assignee`, `claimedBy`, `updatedAt`, `accountId`: all core. No index on a coding column.

`TaskStatus` enum: core = `pending in_progress blocked done cancelled`; coding = `pr_open approved merged deploying deployed`. `TaskKind` = `dev | prd` (`prd` is coding-flavoured planning but is only excluded from ready selection).

## 2. Code classification

| Module | Lines | Class |
|---|---|---|
| `auth.ts`, `routes/tokens.ts`, `token-service.ts`, `account-scope.ts`, `errors.ts`, `validate.ts`, `clock.ts`, `prisma-client.ts`, `index.ts` | ~850 | platform (generic service plumbing) |
| `webhook-dispatcher.ts`, `webhook-timeout-buffer-check.ts` | ~165 | platform (outbound `task.write` events) |
| `claim-ttl-buffer-check.ts` | 39 | platform |
| `task-service.ts` | 1504 | **mixed**: list/get/create/bulk/remove, claim, heartbeat, complete, fail, release, skip/reset, unblock, events (generic, ~800 lines); `listReady` branch/PR logic, `update()` PR stamping, repo/org filters (coding) |
| `routes/tasks.ts` | 1241 | mixed: the 16 routes are all generic by path; the filter query params (`repo`, `org`, `branch`, `pr`) are coding |
| `ready.ts` | 148 | **mixed**: dependency resolution and fresh-claim logic are generic; branch-sibling exclusion, `pr_open`+`isPrMerged`, `merged/deployed` statuses are coding |
| `blocked-by.ts`, `statuses.ts` | 110 + 25 | generic mechanism over a coding-defined status set |
| `task-transition-diff.ts` | 194 | platform mechanism; its audited-field list mixes both |
| `stale-claim-reaper.ts` | 223 | **mixed by construction**: one reaper resets stale `Task` *and* `PullRequest` claims |
| `session-service.ts`, `session-rollup.ts`, `session-retention-reaper.ts`, `routes/sessions.ts` | ~1.2k | platform-ish **(judgment)**: grouping and archival are generic; `computeSessionRollup` counts per-status and computes `pr_blocked`, a coding signal |
| `pull-request-service.ts`, `routes/prs.ts`, `pr-origin-derivation.ts`, `pr-transition-diff.ts` | ~2.9k | coding |
| `verification-check-service.ts`, `routes/verification-checks.ts` | ~600 | coding |
| `openapi-schemas.ts`, `generate-spec.ts` | 1442 + 277 | mixed (schemas for both halves; generates `openapi.json` and `lib/task-store-types.ts`) |

## 3. Entanglement points (what must change to separate)

1. **`TaskService` owns a `PullRequestService`.** The constructor builds one by default, and `update()` calls `pullRequestService.stampOrigin()` on a `pr_open` transition (and `pr_open` requires a non-null `pr`). It is already behind a small `PrOriginStamper` interface, so this is the easiest seam: the PR side becomes an optional hook.
2. **`resolveReadyTasks` encodes the coding lifecycle.** A dependency is satisfied by `merged/done/deploying/deployed/cancelled`, by a same-branch sibling in `pr_open/approved`, or by a `pr_open` task whose PR is merged (`isPrMerged`, which `listReady` stubs to `false`). The generic rule is "closed set + dependency" and the status set and branch rule are injectable policy. The `SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS` env read inside it also ties to `lib/claim-ttl`.
3. **One status enum, one reaper.** `StaleClaimReaper` runs a raw `UPDATE "PullRequest"` next to the Task reset, and `CLOSED_STATUSES`/`OPEN_STATUSES` hardcode the pipeline. A generic core needs a status-set definition supplied per work-item type (the CONTEXT.md "type-defined state machine").
4. **Audit field list and openapi are shared.** `TASK_AUDITED_FIELDS` and `openapi-schemas.ts` list every column. Splitting columns later means these must be assembled from per-half definitions.
5. **Cross-package imports.** `task-store` imports only `@shipwright/lib/*` plus one file from admin (`../../admin/src/task-store-fetchers.ts`, in `admin-fetchers-account-scope.integration.test.ts`, a test). In the other direction admin imports `task-store/src/blocked-by.ts` (type parity check) and the generated `lib/task-store-types.ts`; `metrics` imports the same generated types.

## 4. Consumers (who a change touches)

- **Admin**: `task-store-provisioning-client`, `task-store-fetchers`, session pages/sweeper, queue/task/PR pages, `blocked-by-type-parity.check` (see ADMIN-AUDIT). Provisioning is the platform edge; the views are coding unless built purely on work-item fields.
- **Coding agent**: `agent/src/coding/{check-helpers,check-review,pr-state-reconciler,...}` via HTTP + the generated types.
- **Shipwright plugin** (about 40 files): commands, skills and reference docs call the REST API directly with `jq`; `plugins/shipwright/skills/task-store/references/task-schema.md` documents the schema. This is a public-ish contract for coding agents and must not move.
- **`mcp-server`**: tools are generated from the task-store OpenAPI spec (`scripts/generate-mcp-tools.ts`).
- **`metrics`**: a read-only client over `/tasks` and `/prs`.
- **Dev/ops scripts**: `seed-task-store-token`, `hitl`, `dev-tmux`, `agent-workspace-pull`, `check-coverage`.
- **Chart**: the Helm chart deploys task-store as a Shipwright service; it is not part of the agent image.

## 5. What the platform needs vs what could be extracted

| Level | Contents | Cost | Verdict |
|---|---|---|---|
| **A. Provisioning contract only** | `task-store-provisioning-client`, the `SHIPWRIGHT_TASK_STORE_*` env injection, token minting/revocation, optional wiring in `main.ts` | zero code move; it is already optional in the provisioner | **Needed for the first copy/paste.** Already satisfied by admin staying as-is |
| **B. In-repo work-item seam** | `PrOriginStamper` becomes an optional hook; `ready.ts` takes injected status/dependency policy; reaper takes a record-type list; audited fields come from per-half lists | moderate, behavior-preserving, tests relocate | Prepares the split without moving a repo or touching the DB |
| **C. Work-item base extracted** | generic `Task` core + `TaskEvent` + `TaskToken` + `Session` + claim/heartbeat/skip/unblock/ready + webhook as a module/service the platform ships; coding adds the PR half | high: schema split (or a work-item table with a `metadata`/extension model), a status-set-per-type mechanism, a migration on a live DB, and compatibility for the plugin/MCP/metrics/admin clients | The end state Dan described. **Not needed for the first copy/paste**, and the runtime does not call it |

Important: today only the coding loop claims work. CONTEXT.md deferred the work-item base until a non-coding type needs claiming "so the abstraction comes from a real use case". Dan's call has now made the work-item layer part of the platform, which is a scope decision for C; A and B are compatible with either timing.

## 6. Risks specific to task-store

- **Live-DB schema changes**: any column or table move needs add, migrate, remove (three steps) with a live-data check, and `Task` has many rows. Option B avoids this entirely.
- **Public API contract**: the 16+15+3+4+2 routes and the generated OpenAPI/TS types are consumed by the plugin, MCP, metrics and admin. A split must keep them byte-compatible (or version them) and keep `lib/task-store-types.ts` generation green.
- **Single transaction guarantees**: `claim()` and the transition writers use one transaction across `Task`, `TaskEvent` and the webhook dispatcher; `update()` also writes `PullRequest` in the same transaction. Making the PR half an optional hook must keep that atomicity.
- **Coverage gate and test layout**: task-store has the largest suite in the repo (38.5k lines total including tests); `check-coverage` is path-based.
- **Docs and plugin references** describe the full schema; nothing in them distinguishes platform from coding yet.

## 7. Recommendation

1. Treat **A** as already done for the first platform copy/paste.
2. Include **B** in the in-repo split, ahead of the copy-paste-readiness gate, so task-store's work-item core is separable at the code level (optional PR hook, injected ready policy, per-type reaper). Add an import-boundary test like the agent's one: generic modules must not import the PR/verification modules.
3. Decide **C** separately and later: it is a schema and API-versioning project, not a move. Re-evaluate when a non-coding specialty needs claiming (CONTEXT.md's trigger) or when Dan wants the platform repo to own the work-item service.

## 8. Decisions and open questions

**Decided (Dan, 2026-10-20):**
- **Sessions are not in the work-item base yet.** They stay classified coding until a non-coding specialty needs them.
- **Status set: whatever is simplest for the integrator.** Working default: a fixed generic set (`pending / in_progress / blocked / done / cancelled`) that every integrator sees, with the coding pipeline statuses (`pr_open / approved / merged / deploying / deployed`) layered on top by the coding half. No per-type status machinery until a second type needs one.

**Still open:**

- Is the work-item base meant to be **a module the platform repo ships** (embedded in each consumer's own task-store deployment) or **its own service**? It changes whether the schema is split or composed.
- Who owns the cost/usage columns? They are useful to every agent type but written only by the coding loop today.
- Are the **plugin REST contracts** frozen? They constrain how much of `routes/tasks.ts` can change shape.

## Not audited
- Prisma migration history (how the 70 columns accumulated, which are dead).
- `task-store/openapi.json` content beyond route inventory, and the per-route validation schemas.
- Whether the full suite and coverage gate pass on current main (not run).
- Helm chart and Dockerfile for task-store.

## Reproduce
Read the files listed in Method. Route inventory: `grep` `path:`/`method:` in `task-store/src/routes/*.ts`. Consumers: `grep -rE "SHIPWRIGHT_TASK_STORE_URL|/tasks|lib/task-store-types|task-store/src"` outside `task-store/`, `node_modules`, `docs`, `site`, `planning`, `worktrees`. Runtime check: `grep -rnE "TASK_STORE|/tasks|taskStore" agent/src/runtime`.
