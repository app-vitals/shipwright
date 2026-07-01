# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Shipwright is

Shipwright Harness is **the open-source (MIT) autonomous delivery agent for Claude Code** — a deployable agent plus the autonomous coding system that powers it. The system is a Claude Code plugin (`shipwright`) covering the full delivery loop — **spec → plan → execute → review → deploy** — alongside a metrics dashboard and a Shipwright agent. The brand is **Shipwright Harness**; the installable package is **`shipwright`**.

> The plugin is repo-agnostic: it runs its planning/execution/review/deploy commands against *any* repository. This repo is both the source of the plugin **and** the codebase it ships against.

## Architecture — four artifacts, sequenced A → B → C → D

| Phase | Artifact | Directory | What it is |
|---|---|---|---|
| **A** | **Plugin** (the system) | `plugins/shipwright/` | Commands, skills, agents, scripts users `/plugin install`. Repo-agnostic. |
| **B** | **Metrics dashboard** | `metrics/` | Stateless Hono service: task-store-backed JSON endpoints + a server-rendered dashboard. No database. |
| **C** | **Shipwright agent** | `agent/` | Hono service + Prisma store; a thin autonomous runner: pick next ready task → build → ship PR → forward metrics. |
| **D** | **Task store service** | `task-store/` | Postgres-backed task queue, PR tracking, and scoped tokens. Prisma schema defines `Task`, `PullRequest`, and `TaskToken` models; re-exported as `@shipwright/task-store`. Replaces the JSON file fallback. |

Supporting surfaces (not phased):
- `site/` — Astro + Tailwind marketing site (**shipwrightharness.com**). Self-contained; **not** a Bun workspace; Playwright smoke tests.
- `brand/` — locked design system (`BRAND.md`, `tokens.json`) + CSS build + lint, consumed by `site/` and brand artifacts. Editing brand artifacts triggers the `shipwright-brand` skill.
- `state/` — git-ignored local JSON task-store fallback + cached review state (only written when the GitHub backend isn't active).

## Commands

go-task (`Taskfile.yml`) is the single local entrypoint; the root `package.json` mirrors a subset as `bun run` scripts.

```bash
task setup        # bun install across all workspaces
task ci           # lint → check-strings → typecheck → test → secret-scan → doctor (the merge-blocking gate; CI runs this exact chain)
task test         # bun test            (single file: bun test path/to/file.test.ts)
task lint         # bunx biome lint .
task format       # bunx biome format --write .
task typecheck    # bun run --filter='*' typecheck
task check-strings  # scan entire repo for banned/confidential identifiers (client names, internal infra IDs)
```

Database (admin service):
```bash
export DATABASE_URL_SHIPWRIGHT_ADMIN="postgresql://user:password@localhost:5432/shipwright_admin"
task db:provision   # prisma migrate deploy (idempotent)
task db:migrate     # prisma migrate dev (creates a new migration)
```

Marketing site (run from `site/`, **not** part of `bun test`):
```bash
cd site && npm run dev      # astro dev
cd site && npm run build    # astro build
cd site && npm test         # playwright test (*.spec.ts)
```

> `bunfig.toml` excludes `site/**` from the root `bun test` scan — Playwright's `*.spec.ts` files would otherwise crash Bun's runner. Keep site tests as `*.spec.ts` to stay isolated.

Run the metrics service locally:

```bash
task api        # start metrics dashboard in offline mode → http://localhost:3460/dashboard
task ui         # same as task api (API and UI are one process)
task dev        # dev supervisor: starts metrics + Ctrl-C kills all children
task stack      # full dev stack in a tmux session (6 panes) — requires tmux + Docker + state/dev-agent.env
```

**`task stack` requires `state/dev-agent.env`** — copy `state/dev-agent.env.example` and fill in `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) before running. See `docs/quickstart.md` for the full flow.

`task stack` (`scripts/dev-tmux.ts`) launches one tmux session named `shipwright` with a 6-pane dashboard: **metrics** (SQLite, :3460), **admin** (CRUD API + UI, :3001), **task-store** (:3002), **agent** in Docker with the dev `/chat` endpoint enabled (:3000), the **chat** REPL, and a scratch **logs** shell. It runs a Prisma `migrate deploy` preflight before the admin pane so the admin service's Postgres schema is up to date; the preflight first checks Postgres is reachable and, on macOS, prints the exact `brew`/`createdb` commands and offers to run them (`[y/N]`) before launching. The agent pane builds the Docker image from `agent/Dockerfile` and runs it with `--env-file state/dev-agent.env` so secrets are injected at runtime without appearing in the command or the image. Closing the session (`tmux kill-session -t shipwright`) stops every pane. `task stack` is additive — it does not touch `task dev`, which stays the no-tmux fallback the quickstart depends on; if tmux isn't installed, `task stack` fails fast and points you at `task dev`. The command/pane-env sequence is built by a pure, injected-exec builder (mirrors `scripts/dev.ts`) and unit-tested in `scripts/dev-tmux.unit.test.ts`.

## Before you commit — this repository is going public

This repo is **private today but destined to be a public, MIT open-source project.** Git history is permanent. **Scrub before the commit, not after the push.**

**The rule:** review every change before staging it. Stage specific files — **never `git add -A`/`-u` blindly**. When unsure whether something is proprietary, **ask before committing.**

**Scrub for:** secrets & credentials (`ANTHROPIC_API_KEY`, `GH_TOKEN`, `SESSION_SECRET`, `.env` contents, private keys) · client/customer/partner names · internal infra identifiers (cloud project names, analytics project IDs, internal hostnames) · internal PR/issue/Slack/Jira links · local filesystem paths revealing usernames (`/Users/<name>/...`) · financials, compensation, PII.

`task check-strings` (banned-strings scan) is the CI backstop — not a substitute for this discipline. Internal, build-time-only notes live in the git-ignored `CLAUDE.local.md`; **read it for operational context before working in this repo.**

## How work is tracked

Two surfaces — do not conflate them:

1. **Automated task store** (what `/shipwright:dev-task` and the agents read/write): the **HTTP Shipwright task-store service** (artifact D). Individual tasks like `PV-1.2` live here. Query it directly — **`gh issue list` does not see these tasks.**
   ```bash
   curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
     "$SHIPWRIGHT_TASK_STORE_URL/tasks?ready=true" | jq '.tasks'
   ```
2. **Manual human planning** (historical): GitHub Issues under the **`shipwright-oss`** milestone, each with a machine-readable ```` ```shipwright ```` YAML block and a `status:*` label. A record/planning surface for humans; the automated loop does **not** read it.
   ```bash
   gh issue list --milestone shipwright-oss --state open --label status:pending
   ```

**Status lifecycle:**
```
pending → in_progress → pr_open → merged → deployed → done
```
plus `approved`, `blocked`, `cancelled`.

### Execution loop

1. Pick a `pending` task whose every `dependencies` entry is done.
2. Branch from the task's `branch` field (`feat/sw-x-y-slug`) — never work on `main`.
3. Build + land tests **in the same PR, at the correct layer** (no "tests later").
4. Open a PR; move the status through its lifecycle.

Driven by Shipwright's own commands: `/shipwright:dev-task` → `/shipwright:review` / `/shipwright:patch` → `/shipwright:deploy`. The `ship-loop` skill drains the queue autonomously (one pipeline step per call, wrapped by `/loop`).

**Task-store connection** is env-var-only: both `SHIPWRIGHT_TASK_STORE_URL` and `SHIPWRIGHT_TASK_STORE_TOKEN` must be set for task operations to function. There is no GitHub fallback and no file-based config — the provisioner injects these two vars into managed GKE agents, and local installs must set them explicitly. If task operations seem to no-op, check `SHIPWRIGHT_TASK_STORE_URL` first.

## Test conventions

Tests land **with** the code, at the correct layer — same PR, no "add tests later" tasks. Layer is encoded in the filename:

| Suffix | Layer | What it covers |
|---|---|---|
| `*.unit.test.ts` | unit | pure logic, no I/O |
| `*.integration.test.ts` | integration | real dependency behavior via recorded fixtures / injected doubles |
| `*.smoke.test.ts` | smoke | Hono endpoints via in-process `app.request()` (no real socket) |
| `*.spec.ts` (in `site/`) | e2e | the site in a real browser via Playwright |

**Test isolation (hard rule):** inject time via a `Clock`; test external clients (task store, GitHub) with recorded fixtures. **No `mock.module()`, no `global.fetch`/`global.*` overrides** — Bun shares the test process, so leaked globals break sibling suites.

## Conventions

- **No new coupling:** the plugin stays repo-agnostic; the metrics service and the agent depend on no external platform service.
- **Local-first:** everything runs offline by default (fixtures / injected doubles / scratch queue); live external calls only when env explicitly enables them.
- **Conventional Commits** — required (a `pr-title-lint` workflow enforces PR titles); releases are automated via semantic-release.
- **Lint/format:** Biome (2-space indent, organize-imports). Run `task lint` before committing.
- **License:** MIT across all artifacts.

## Env var namespacing convention

Env vars read by Shipwright services are namespaced so each service is portable across any infra:

- **Suite-wide:** `SHIPWRIGHT_<THING>` — e.g. `SHIPWRIGHT_SESSION_SECRET`, `SHIPWRIGHT_ENCRYPTION_KEY`, `SHIPWRIGHT_AGENT_API_KEY`.
- **Per-subservice:** `SHIPWRIGHT_<SUBSERVICE>_<THING>` — e.g. `SHIPWRIGHT_ADMIN_ALLOWED_EMAILS`, `SHIPWRIGHT_ADMIN_APP_BASE_URL`.
- **DB connection strings:** `DATABASE_URL_SHIPWRIGHT_<SUBSERVICE>` — never bare `DATABASE_URL` (collides with the host's own DB var).
- **Universally-meaningful third-party vars** keep conventional names: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PORT`.
- **Secret manager IDs** map 1:1 to env var names: lowercase-kebab ↔ uppercase-snake (e.g. `shipwright-admin-allowed-emails` ↔ `SHIPWRIGHT_ADMIN_ALLOWED_EMAILS`).

## Database env vars

Each Prisma service reads its own `DATABASE_URL_*` — never a shared connection.

| Variable | Service | Schema |
|----------|---------|--------|
| `DATABASE_URL_SHIPWRIGHT_ADMIN` | `@shipwright/admin` | `admin/prisma/schema.prisma` |
| `DATABASE_URL_SHIPWRIGHT_TASK_STORE` | `@shipwright/task-store` | `task-store/prisma/schema.prisma` |
| `DATABASE_URL_SHIPWRIGHT_CHAT` | `@shipwright/chat` | `chat/prisma/schema.prisma` |

The schema uses `provider = "postgresql"`. All database connection strings must be Postgres connection strings: `postgresql://user:password@host:5432/database`.

For the full configuration reference (all env vars, agent config, policy config), see [`docs/configuration.md`](./docs/configuration.md).

## Debugging

- **A 401 with no `WWW-Authenticate` header is not the auth middleware.** `createAdminAuthMiddleware` always sets `WWW-Authenticate` on its bearer-path 401s. A `{"error":"Unauthorized"}` 401 *without* that header is surfaced via the app's `onError` from a downstream call inside a handler — typically a `KubernetesClient` request the K8s API rejected. Tell-tale: read-only routes (DB only) return 200 while a route that calls the K8s API (agent `reconcile` / `provision`) 401s with the *same* token — that's a calls-the-dependency correlation, not an auth or routing bug. Check the response header (`curl -sD - -o /dev/null …`) before suspecting the token. Common cause of the K8s 401: the pod's ServiceAccount was deleted+recreated (new UID), invalidating the bound token in the already-running pod even though its `exp` is far in the future — restart the pod, and don't render the SA as a Helm hook (hooks recreate it every `helm upgrade`).

## Reference

To load additional context into a session, add `@docs/filename.md` entries here — don't create separate `CLAUDE-REFERENCE.md` or similar files.

- **docs/architecture.md** — the four-artifact A→B→C→D design (plugin / metrics / agent / task-store), supporting surfaces, and workspace layout
- **docs/testing.md** — the four-layer test model (unit / integration / smoke / e2e), run commands, speed budgets, and the isolation contract
- **docs/metrics.md** — metrics service (B): JSON endpoints, server-rendered dashboard, dual auth (Bearer / session), and environment
- **docs/agent.md** — Shipwright agent (C): runtime + admin CRUD APIs, the six-model Prisma store, and encryption/env notes
- **docs/deploy-kubernetes.md** — Kubernetes deployment guide: Minikube / GKE (Gateway API + cert-manager) / EKS (ALB), the agent runtime-provisioning RBAC model, and auth modes
- **docs/test-readiness/test-system.md** — the authoritative test blueprint: layer matrix, boundary rules, per-component budgets, CI pipeline shape, and the full isolation contract
- **docs/migration.md** — breaking changes and migration steps across versions (e.g. `AgentProvisioner.reconcile()` interface change)
