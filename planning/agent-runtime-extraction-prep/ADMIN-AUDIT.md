# Admin / platform extraction audit

**Date**: 2026-10-20 · **Commit audited**: `13bdb966e` (origin/main) · **Method**: static import graph of the 92 non-test `.ts` files in `admin/src` (122 test files), route inventories of `admin-ui.ts` and `agents-api.ts`, function inventory of `admin-ui-pages.ts`, the Prisma schema, and greps across the rest of the repo. Read-only; no build or tests were run.

**Why**: Dan's goal is to move the agent runtime, admin and provisioning (plus the shared `lib` pieces they use) into their own repo, as close to a copy/paste as possible, with Shipwright (coding) and the specialists repo depending on it. The `agent/` half is already split (`agent/src/runtime` vs `coding`, see [`../agent-types-decoupling/AUDIT.md`](../agent-types-decoupling/AUDIT.md)). This audit covers what that one did not: admin, provisioning, `lib`, `agent-types/`, and everything else a copy would drag along or break.

**Caveat**: classification is by reading file headers, imports, route lists and grep counts, not by running anything. Line ranges for the mixed UI files are approximate (±50 lines). Judgment calls are marked **(judgment)**.

## Headline

1. **Admin is mostly platform.** Roughly 75% of source is accounts, agents, provisioning, push, chat views, auth. About 7–8k lines are coding-shaped (task, PR, session and work-queue views and their services), and almost all of that sits in **three large mixed files**: `admin-ui-pages.ts` (7.4k lines), `admin-ui.ts` (5.2k) and `agents-api.ts` (2.7k).
2. **There is no cycle and no import from `agent/`.** `admin/src` imports only `@shipwright/lib/*`, its own Prisma client, and three things outside it (below). The `agent -> admin` edge is type-only (`AgentPlugin`, `AgentConfigResponse`, `AgentCronJob`) plus the generated `lib/admin-types.ts`.
3. **Copy/paste blockers inside `admin/src` are few and concrete** (section 3): three hard imports out of the package, a repo-root-relative manifest loader with a hardcoded `coding` fallback, `"coding"` baked into self-serve, and the coding/task-store UI.
4. **The larger blocker is outside `admin/`**: other services' Dockerfiles, CI, the chart, root scripts and tsconfig paths all hardcode `admin/`, `lib/` and `agent-types/` (section 6).
5. **No seam exists in admin yet.** `main.ts` (1k lines) is hand-wired the way `agent/src/index.ts` was. The agent solution (`AgentExtension` + thin entry) transfers directly; admin needs an equivalent.

## 1. Classification of `admin/src`

### Platform (stays with the extracted repo)
- **Accounts and self-serve**: `account-*`, `accounts*`, `trial-expiry*`, `self-serve-config`, `caller-scope`, `api-auth`, `dev-auth-guard`, `okta-auth-client`, `google-auth-client`
- **Agents core**: `agents`, `agents-api` (minus routes below), `agent-envs`, `agent-tools`, `agent-tokens`, `agent-plugins`, `agent-members`, `agent-cron-jobs`, `agent-cron-runs`, `agent-cron-run-stats`, `agent-chat-tokens`, `agent-account-assignment`, `agent-anthropic-identity`, `anthropic-*`, `agent-deletion*`
- **Provisioning**: `agent-provisioner`, `agent-manifest`, `kubernetes-client`, `startup-policy-reconcile`, `chat-service-provisioning-client`, `slack-provisioning-{client,service}`, `github-app-provisioning-client`, `github-provisioning-service` (GitHub is a runtime capability for every type per the ARD plan), `agent-github-installations` **(judgment: GitHub installations are runtime-wide)**
- **Type system**: `agent-type-registry`, `agent-type-manifest-loader` (needs work, section 3)
- **Infra**: `api`, `server`, `main`, `prisma-client`, `prisma-tx`, `crypto`, `token-crypto`, `errors`, `clock`, `openapi-schemas` (mixed, section 2), `attachment-validation`, `chat-markers`, `http-chat-client`
- **Push**: `push-*`, `pwa`, `admin-ui-push-test` (note `pwa.ts` imports `brand/tokens.json`)
- **UI shell and platform pages**: `admin-ui-layout`, `admin-ui-styles`, `admin-ui-account*`, `admin-ui-accounts*`; in `admin-ui.ts` the login/auth, agents, agent settings, crons/tools/tokens/members, connect-slack/github, provision and chat routes

### Coding-shaped (moves behind an admin extension seam)
Whole files, ~3.3k lines:

| File | Lines | Why |
|---|---|---|
| `agent-work-queue.ts`, `agent-work-queue-merge.ts` | 69 + 174 | work-queue snapshot service; coding loop reports it |
| `agent-phase-methodology.ts` | 62 | per-phase subagent override for dev-task/review/patch/plan |
| `dev-task-adherence.ts` | 332 | imports `plugins/shipwright/references/required-steps/dev-task.json` |
| `task-store-fetchers.ts` | 147 | admin UI's task-store HTTP client |
| `session-scope.ts`, `session-follow-service.ts` | 211 + 198 | sessions are a task-store concept (`GET /sessions`) |
| `session-alert-sweeper.ts` | 740 | the admin's only task-store background loop |
| `admin-ui-sessions.ts`, `admin-ui-sessions-list.ts`, `admin-ui-session-follow.ts`, `admin-ui-session-admin-actions.ts` | 293 + 710 + 122 + 187 | session pages |
| `blocked-by-type-parity.check.ts` | n/a | imports `../../task-store/src/blocked-by.ts` |

Parts of mixed files, ~5k lines:

| Where | Coding part | ~Lines |
|---|---|---|
| `admin-ui-pages.ts` | tasks page and detail, task-state classification, dependency graph layout, session detail, PRs page and detail, queue activity, merged queue, verification checks, `TaskItem`/`PullRequestItem`/`WorkQueueItem` types (≈ 745–912 types; 2918–5900) | ~3.5k |
| `admin-ui.ts` | `/admin/queue-activity`, `/admin/agents/:id/queue-activity`, `/admin/tasks*`, `/admin/prs*`, `/admin/sessions/:id`, `/public/tasks` (≈ 1669–1805, 2250–2305, 3649–4430, 5189+) | ~1.1k |
| `agents-api.ts` | routes `/agents/{id}/work-queue`, `/phase-methodology*`, `/dev-task-adherence`, `/cron-runs/dev-task-adherence` | ~400 |
| `openapi-schemas.ts` | schemas for the above (not itemised) | ? |
| `agent-cron-jobs.ts` | `listShipwrightLoopJobs` (looks up the `shipwright-loop` cron by name) | ~15 |

### Coding by default (the hardcoded `"coding"` type)
`DEFAULT_AGENT_TYPE_NAME = "coding"` and the unknown-type fallback (`agent-type-manifest-loader.ts`), `SELF_SERVE_AGENT_TYPE = "coding"` (`account-agent-create.ts`, `agents-api.ts`, `admin-ui.ts`), the `"coding"` hidden input in the new-agent form, and `Agent.typeName @default("coding")`. These are not coding *logic*; they are a coding *default* in a platform that should name no type.

## 2. Mixed-file split points (the real work)

- **`admin-ui-pages.ts` (7.4k)** is a single module of pure render functions plus types, so splitting is mechanical: coding pages and types move to `coding/` files, shared helpers (`renderLayout` pieces, `heartbeatFreshness`, `partitionCronsForActivityDisplay`, constants) stay. Two coupling points to watch: `agent-deletion-checklist` and `attachment-validation` are imported by it; `renderAgentDetailPage` (≈1503–2566) renders the work-queue card, GitHub installations card and phase-methodology card inline, so the platform agent page needs **slots** for coding cards, not just file moves. This is the one place where the split is more than moving code.
- **`admin-ui.ts` (5.2k)** is one `createAdminUIRoutes(deps)` function with a 30-field `AdminUIDeps` interface; the coding routes are contiguous blocks, and `AdminUIDeps` carries `agentWorkQueueService`, `agentPhaseMethodologyService` and the task-store fetchers. The platform deps stay; the coding deps become an extension's own deps.
- **`agents-api.ts` (2.7k)** is `createRoute` OpenAPI route definitions; the coding routes are separable by path. The admin OpenAPI spec (`admin/openapi.json`, generated, and `lib/admin-types.ts` generated from it) is the **runtime↔admin contract**. If coding routes move to an extension they must still appear in the generated spec Shipwright's agent consumes, or the runtime's typed client loses them. Whether the extension contributes to the spec is a design decision (section 7).
- **`main.ts` (1k)** wires everything and the only background loops: `SessionAlertSweeper` (coding), `TrialExpiry*`, `AccountTrial*` (platform), `startupPolicyReconcile` (platform). Same shape as the old `agent/src/index.ts`.

## 3. Hard copy/paste blockers inside admin

1. **`admin-ui-pages.ts`/`dev-task-adherence.ts` import `../../plugins/shipwright/references/required-steps/dev-task.json`.** Coding-only; goes away with the file moving to the coding extension. (`dev-task-adherence.ts` also feeds `main.ts`/`agents-api.ts`.)
2. **`blocked-by-type-parity.check.ts` imports `../../task-store/src/blocked-by.ts`.** A cross-package type-parity check; it belongs with the task-store/coding side.
3. **`pwa.ts` (+ its test) imports `../../brand/tokens.json`.** The root `brand/` is Shipwright's. The platform needs the tokens as its own asset or as an injected theme.
4. **`agent-type-manifest-loader.ts` resolves `join(import.meta.dir, "..", "..", "agent-types")`.** After a move it silently depends on the repo layout. The platform needs the manifest directory (and default type name) to be configuration, and the `coding` manifest must be supplied by Shipwright, not the platform. The same assumption exists in the runtime: `agent/src/runtime/setup.ts` reads `<repoRoot>/agent-types/<type>/manifest.yaml` and falls back to the built-in `agent/workspace/` for coding.
5. **`typeName` default and the unknown-type fallback are `coding`** (section 1). Needs a configurable default type with the platform shipping none (or only a neutral one).
6. **Task-store and chat provisioning are wired into the provisioner.** `agent-provisioner`, `agent-manifest` (env entries `SHIPWRIGHT_TASK_STORE_*`), `agent-deletion` and `main.ts` take an optional `taskStore` client next to `chatService`. **Decided (Dan, 2026-10-20): task-store has a platform part, the work-item base (claim/heartbeat/release/block/ready, dependencies, hitl, spin protection, audit events, `metadata`), and a much larger coding part (repo/branch/PR/CI lifecycle, `PullRequest`, findings, verification checks).** So the provisioning client, token minting and `SHIPWRIGHT_TASK_STORE_*` env injection are platform, and stay in the provisioner. What this implies: task-store itself must be split along that line, which is not audited here (see "Not audited" and section 8).
7. **`AdminUIDeps` and the sweeper depend on the task-store URL/token.** The coding views disappear behind the seam; any view built purely on work-item fields (generic queue, sessions) may stay platform. Needs the task-store audit to say which.

No file in `admin/src` imports from `agent/`, `task-store/`, `chat/`, `metrics/` or `mcp-server/` other than items 1–3.

## 4. Database (Prisma, `admin/prisma`, 22 models, 44 migrations)

| Group | Models / columns | Class |
|---|---|---|
| Platform | `Agent`, `AgentEnv`, `AgentCronJob`, `AgentTool`, `AgentToken`, `AgentPlugin`, `AgentMember`, `Account`, `AccountMember`, `AccountInvite`, `AgentCronRun*` (3), `AgentChatTokenUsageDailyByModel`, `PushSubscription`, `UserNotificationPrefs`, `ChatThreadWatch` | platform |
| Coding-shaped tables | `AgentWorkQueueSnapshot`, `AgentPhaseMethodology` | coding |
| Coding-shaped `Agent` columns | `reviewAuthorAllowlist`, `patchAuthorAllowlist`, `autoPostReviews`, `allowSelfReview`, `minConfidence`, `maxFindings` | coding (PR review/patch policy) |
| Platform-by-decision | `cleanupMergedWorktrees`, `cleanupAfterDays` (worktree reaper is runtime), `repos` (repo scope is runtime), `AgentGitHubInstallationsSnapshot` | platform |
| Session-related | `SessionFollow`, `SessionAlertState` | coding (sessions are task-store) **(judgment)** |

Two facts matter: (a) it is **one schema file and one migration history** shared by `Agent` and its coding extensions, and several relations hang off `Agent` (`workQueueSnapshot`, `phaseMethodologies`); (b) **four other services' Dockerfiles `COPY admin/prisma`** (task-store, chat, metrics, mcp-server) solely to satisfy workspace install, so the Prisma directory is also part of the monorepo's install graph. Moving coding tables or columns out is a real, multi-step migration on a live database, and it is **not required** for a copy/paste: the platform can carry nullable/defaulted coding columns and tables until a later cleanup. Prisma 7 supports a multi-file schema (`prisma/schema/*.prisma`), so the coding models could at least be isolated in their own file now, without a migration.

## 5. Shared `lib` (`@shipwright/lib`, 18 modules)

Who imports each (non-test files; runtime / admin / coding+scripts / other services):

| Module | Runtime | Admin | Coding/scripts | Other svc | Verdict |
|---|---|---|---|---|---|
| `sentry` | 6 | 2 | 1 | 5 | shared |
| `progress-phases` | 3 | 1 | 0 | 1 (chat) | shared (platform + chat) |
| `claim-ttl` | 1 (`DEFAULT_CLAUDE_TIMEOUT_MS`) | 1 (UI constant) | 1 | 4 (task-store) | **shared; mixed content**: the Claude timeout is runtime, the claim TTL is task-store. Needs splitting |
| `default-agent-env`, `cli-flags`, `clone-plan`, `admin-types` | 1–2 | 0–1 | 0 | 0 | platform |
| `pricing` | 1 | 0 | 0 | 1 (metrics) | shared |
| `org-repo`, `github-login`, `secret-env-vars`, `request-context` | 0 | 2–4 | 0 | 0–4 | admin-owned; `request-context`/`org-repo` also task-store |
| `default-account`, `pg-sslmode`, `graceful-shutdown`, `http` | 0 | 0–2 | 0 | 2–6 | shared with task-store/chat |
| `task-store-types` (generated) | 0 | 1 (`task-store-provisioning-client`) | 0 | 1 | task-store |
| `chat-notify` | 0 | 0 | 0 | 3 (chat) | chat |
| `web/toolbar.ts` | 0 | 1 (`admin-ui-styles`) | 0 | 3 (metrics) | shared |
| `admin-types` (generated from `admin/openapi.json`) | 1 | 0 | 0 | 0 | platform contract |

The platform set needs **~13 of the 18**; ~9 of those are also used by task-store, chat or metrics. A copy leaves Shipwright's other services needing those modules from somewhere, so the choice is one of: copy them (small, stable, leaf modules, low drift risk), publish them as a package, or have Shipwright depend on the platform repo for them. `claim-ttl.ts` must be split first either way.

## 6. Everything else that references the moving set

- **Dockerfiles**: `admin/Dockerfile`, `agent/Dockerfile` (`COPY admin/package.json`, `admin/prisma`, `agent-types/`, `lib/`), plus task-store/chat/metrics/mcp-server (`COPY admin/package.json`, `admin/prisma`).
- **CI and chart**: `.github/workflows/ci.yml` and `sync-plugin-version.yml` (path filters, `installPlugins()` in `setup.ts`), `charts/shipwright/templates/admin-deployment.yaml` and `values.yaml` (`admin/src` mentions), minikube example values.
- **Root config**: `package.json` workspaces + `generate:admin-spec/types` scripts, `Taskfile.yml`, `bunfig.toml`, `biome.json`, `tsconfig.json`, `agent/tsconfig.json` (`@shipwright/admin` path alias to `../admin/src`), `plugins/shipwright/tsconfig.json` (includes `../../agent/src`).
- **Root scripts importing admin or agent-types**: `seed-dev-agent`, `dev`, `dev-tmux`, `minikube`, `wait-for-agent`, `generate-admin-spec`, `generate-agent-type-schema`, `check-coverage`, `check-config-docs`, `build-pwa-icons`, `refresh-anthropic-openapi-spec`, `hitl*`, `agent-workspace-pull` (+ tests). Most are dev tooling that follows whichever side owns local dev.
- **Cross-package test coupling**: `task-store/src/admin-fetchers-account-scope.integration.test.ts` and `mcp-server/src/tool-caller.integration.test.ts` import admin; `chat/src/stall-reaper.ts` only mentions an admin constant in a comment (the 120s/65min thresholds are duplicated by hand between `admin-ui-pages.ts` and `lib/claim-ttl.ts`).
- **`plugins/shipwright/scripts/diagnose-review-candidacy.ts`** imports `@shipwright/admin` types (coding side reading the admin contract; fine after extraction if the types are importable).
- **`agent-types/`**: `coding/manifest.yaml` (222 lines, references `admin/src/...` in comments) and `specialist/` (manifest + 4 templates). The manifest schema (`AgentTypeManifestSchema`) lives in `admin/src/agent-type-registry.ts`. Whose directory owns which type is the open point in blocker 4.
- **`agent/workspace/` templates** (`RUNTIME.md.template` etc.) belong with the runtime; the coding variant (`CLAUDE-HITL.md.template`, coding `CLAUDE.md`) belongs to the coding specialty. Already partly addressed by ARD-6.1/6.2.
- **Docs and public site** mention these paths widely (`docs/agent*.md`, `docs/configuration-agent.md`, site pages); `scripts/check-config-docs.ts` and `docs-source-map.unit.test.ts` pin paths.

## 7. Proposed extraction manifest (what moves)

**Platform set** = `agent/src/runtime/**` + `agent/src/{index,entrypoint-main}.ts` as the thin entry (composition roots stay per consumer) · `admin/**` minus the coding extension · `lib/` modules in section 5 marked platform/shared · `agent-types/` schema + the neutral default (`coding` and `specialist` manifests move to their owners) · `agent/workspace/` runtime templates · `agent/Dockerfile` and `admin/Dockerfile`.

**Stays in Shipwright** = `agent/src/coding/**` · the admin coding extension (section 1) · `task-store/`, `chat/`, `metrics/`, `mcp-server/`, `plugins/`, `site/` · coding manifest and templates · coding root scripts.

**Order of attack (each step independently shippable and behavior-preserving):**
1. Remove the three hard imports (section 3 items 1–3) and make the type-manifest directory and default type configuration, not repo layout.
2. Introduce the admin extension seam (`AdminExtension`: routes, UI pages, agent-detail cards, background passes, OpenAPI contributions) and a thin entry, mirroring `AgentExtension`/`startAgent`.
3. Move the coding-shaped admin modules and the mixed-file blocks behind it, under `admin/src/coding/` with an import-boundary test like `agent/src/import-boundary.unit.test.ts`.
4. Split `lib/claim-ttl.ts`, decide the `lib` delivery (copy / publish / depend), and isolate coding Prisma models in their own schema file.
5. Add the **copy-paste-readiness gate**: a test that takes the manifest, walks the import closure of the platform set, and fails on any edge that leaves it (including relative `../../` and `@shipwright/*` workspace specifiers that point outside).
6. Optionally consolidate the platform set under one top-level directory so extraction is a single `git filter-repo --path`.
7. Specialty rename (`typeName`/`AgentType`/schema) before anything is published.

## 8. Open decisions

- **Directory consolidation** (step 6): one `platform/` directory vs copying the manifest paths. The first makes the gate trivial and extraction a one-liner; the cost is one large mechanical PR touching CI, Dockerfiles, chart and scripts.
- **Task-store split (decided in principle, 2026-10-20):** work-item base is platform, the rest is coding. Open: where the seam lands in the `Task` model (~70 columns, one Prisma schema), whether the work-item base is its own service/repo or a module the platform ships, and which admin views (work-queue snapshot, sessions, alerts) are work-item generic. Needs its own audit before the admin session/queue code can be classified for good; until then those files stay classified coding **(judgment)**.
- **How does the extension contribute to the admin OpenAPI spec**, given `lib/admin-types.ts` is generated from it and the runtime consumes it?
- **Coding Prisma columns/tables**: leave in the platform schema (nullable/defaulted, no migration) vs move. Default here: leave, isolate in a separate schema file.
- **`lib` delivery**: copy, publish, or depend on the platform repo.
- **Rename timing** for "specialty" (needs add, migrate, remove on a live column; `Agent.typeName` is DB-backed).
- **Image names**: `shipwright-agent` needs a plan once the runtime has its own image (carried over from the ARD plan).

## Not audited
- **`task-store/`** (service, Prisma schema, claim/ready logic). Dan's call that its work-item base is platform makes it part of the extraction; it needs the same treatment as `admin/` (what is generic, what is coding, where claim/liveness logic is entangled with coding status transitions, per the CONTEXT.md warning).
- `agent/scripts/` beyond `cutover-validate`, `backfill-pr-origin`; `charts/` internals beyond mentions; `site/`.
- Whether the build and full test suite pass on current main (not run).
- Line-exact boundaries inside `admin-ui-pages.ts`/`admin-ui.ts` and the coding share of `openapi-schemas.ts` (the extension-seam task should establish them).
- Behavioral boot-order assumptions inside `admin/src/main.ts` (as with the agent's `index.ts`, the first thing the seam task must establish).

## Reproduce
Import graph: `bun /tmp/graph.ts`-style script over `admin/src/*.ts` excluding `*.test.ts`, `*.fixtures.ts`, `*.check.ts`; collect `./x` specifiers as local edges and `../` / `@shipwright/*` as external. Routes: grep `createRoute` `path:` in `agents-api.ts` and `.get/.post("/admin/...` in `admin-ui.ts`. `lib` usage: grep `@shipwright/lib/<module>` per consumer directory.
