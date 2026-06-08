# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Shipwright is

Shipwright Harness is **the open-source (MIT) autonomous delivery agent for Claude Code** — a deployable agent plus the autonomous coding system that powers it. The system is a Claude Code plugin (`shipwright`) covering the full delivery loop — **spec → plan → execute → review → deploy** — alongside a metrics dashboard and a Shipwright agent. The brand is **Shipwright Harness**; the installable package is **`shipwright`**.

> The plugin is repo-agnostic: it runs its planning/execution/review/deploy commands against *any* repository. This repo is both the source of the plugin **and** the codebase it ships against.

## Architecture — three artifacts, sequenced A → B → C

| Phase | Artifact | Directory | What it is |
|---|---|---|---|
| **A** | **Plugin** (the system) | `plugins/shipwright/` | Commands, skills, agents, scripts users `/plugin install`. Repo-agnostic. |
| **B** | **Metrics dashboard** | `metrics/` | Stateless Hono service: PostHog-backed JSON endpoints + a server-rendered dashboard. No database. |
| **C** | **Shipwright agent** | `agent/` | Hono service + Prisma store; a thin autonomous runner: pick next ready task → build → ship PR → forward metrics. |

Supporting surfaces (not phased):
- `site/` — Astro + Tailwind marketing site (**shipwright-harness.com**). Self-contained; **not** a Bun workspace; Playwright smoke tests.
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

Database (agent only):
```bash
export DATABASE_URL_AGENT="file:./agent/dev.db"   # SQLite for local dev; postgres URL for prod
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

There is **no `task dev`/`task api`/`task agent`** yet — services are started directly via their own entrypoints. Don't assume aggregate run tasks exist; check `Taskfile.yml`.

## Before you commit — this repository is going public

This repo is **private today but destined to be a public, MIT open-source project.** Git history is permanent. **Scrub before the commit, not after the push.**

**The rule:** review every change before staging it. Stage specific files — **never `git add -A`/`-u` blindly**. When unsure whether something is proprietary, **ask before committing.**

**Scrub for:** secrets & credentials (PostHog API key, `ANTHROPIC_API_KEY`, `GH_TOKEN`, `SESSION_SECRET`, `.env` contents, private keys) · client/customer/partner names · internal infra identifiers (cloud project names, analytics project IDs, internal hostnames) · internal PR/issue/Slack/Jira links · local filesystem paths revealing usernames (`/Users/<name>/...`) · financials, compensation, PII.

`task check-strings` (banned-strings scan) is the CI backstop — not a substitute for this discipline. Internal, build-time-only notes live in the git-ignored `CLAUDE.local.md`; **read it for operational context before working in this repo.**

## How work is tracked

The task store is **GitHub Issues** in this repo, configured via `.shipwright.json` (`taskStore: "github"`, owner `app-vitals`, repo `shipwright`). Work is planned as issues under the **`shipwright-oss`** milestone, each with a machine-readable ```` ```shipwright ```` YAML block (`id`, `layer`, `branch`, `dependencies`, `hours`, `status`, `pr`) and a `status:*` label.

**Find the next ready task:**
```bash
gh issue list --milestone shipwright-oss --state open --label status:pending
```

**Status lifecycle** (the label is the single signal of where a task is):
```
pending → in_progress → pr_open → merged → deployed → done
```
plus `approved`, `blocked`, `cancelled`.

### Execution loop

1. Pick a `status:pending` task whose every `dependencies` entry is `status:done`.
2. Branch from the task's YAML `branch` field (`feat/sw-x-y-slug`) — never work on `main`.
3. Build + land tests **in the same PR, at the correct layer** (no "tests later").
4. Open a PR; move the status label through its lifecycle.

Driven by Shipwright's own commands: `/shipwright:dev-task` → `/shipwright:review` / `/shipwright:patch` → `/shipwright:deploy`. The `ship-loop` skill drains the queue autonomously (one pipeline step per call, wrapped by `/loop`).

**Task-store config resolution** (`plugins/shipwright/scripts/create-task-store.ts` → `loadConfig`): (1) walk up from cwd for `.shipwright.json`; (2) fall back to `SHIPWRIGHT_CONFIG` env var; (3) fall back to local JSON (`state/`). If task operations seem to no-op, confirm which backend is active.

## Test conventions

Tests land **with** the code, at the correct layer — same PR, no "add tests later" tasks. Layer is encoded in the filename:

| Suffix | Layer | What it covers |
|---|---|---|
| `*.unit.test.ts` | unit | pure logic, no I/O |
| `*.integration.test.ts` | integration | real dependency behavior via recorded fixtures / injected doubles |
| `*.smoke.test.ts` | smoke | Hono endpoints via in-process `app.request()` (no real socket) |
| `*.spec.ts` (in `site/`) | e2e | the site in a real browser via Playwright |

**Test isolation (hard rule):** inject time via a `Clock`; test external clients (PostHog, GitHub) with recorded fixtures. **No `mock.module()`, no `global.fetch`/`global.*` overrides** — Bun shares the test process, so leaked globals break sibling suites.

## Conventions

- **No new coupling:** the plugin stays repo-agnostic; the metrics service and the agent depend on no external platform service.
- **Local-first:** everything runs offline by default (fixtures / injected doubles / scratch queue); live external calls only when env explicitly enables them.
- **Conventional Commits** — required (a `pr-title-lint` workflow enforces PR titles); releases are automated via semantic-release.
- **Lint/format:** Biome (2-space indent, organize-imports). Run `task lint` before committing.
- **License:** MIT across all artifacts.

## Database env vars

Each Prisma service reads its own `DATABASE_URL_*` — never a shared connection.

| Variable | Service | Schema |
|----------|---------|--------|
| `DATABASE_URL_AGENT` | `@shipwright/agent` | `agent/prisma/schema.prisma` |

The schema uses `provider = "sqlite"` for local portability. Swap to `postgresql` and regenerate migrations when deploying against real Postgres.

## Reference

To load additional context into a session, add `@docs/filename.md` entries here — don't create separate `CLAUDE-REFERENCE.md` or similar files.

- **docs/architecture.md** — the three-artifact A→B→C design (plugin / metrics / agent), supporting surfaces, and workspace layout
- **docs/testing.md** — the four-layer test model (unit / integration / smoke / e2e), run commands, speed budgets, and the isolation contract
- **docs/metrics.md** — metrics service (B): JSON endpoints, server-rendered dashboard, dual auth (Bearer / session), and environment
- **docs/agent.md** — Shipwright agent (C): runtime + admin CRUD APIs, the six-model Prisma store, and encryption/env notes
- **docs/test-readiness/test-system.md** — the authoritative test blueprint: layer matrix, boundary rules, per-component budgets, CI pipeline shape, and the full isolation contract
