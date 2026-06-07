# CLAUDE.md

Guidance for Claude Code (claude.ai/code) and contributors working in this repository.

## What Shipwright is

Shipwright is a **Claude Code plugin toolchain for the full delivery loop — spec → plan → execute → review → deploy** — plus a metrics dashboard and a reference agent. You install the plugin into Claude Code and drive planning, queue-based execution, policy-controlled review, a test-readiness pipeline, and autonomous deploy against your own repository.

> 🚧 **Early development.** The toolchain is being built out in this repository and isn't ready for general installation yet. Track progress in the [issues](https://github.com/app-vitals/shipwright/issues).

## Architecture / roadmap (A → B → C)

Three artifacts, sequenced so the repo is useful at the end of each phase:

| Phase | Artifact | What it is |
|---|---|---|
| **A** | **Plugin** | The toolchain users `/plugin install` (commands, skills, agents, scripts). Repo-agnostic — runs its planning/execution/review/deploy commands against any repo. |
| **B** | **Metrics dashboard** | A stateless Hono service: PostHog-backed JSON endpoints + a server-rendered dashboard (task throughput, CI first-pass rate, review verdicts, estimation accuracy). No database. |
| **C** | **Reference agent** | A thin, purpose-built autonomous runner: pick the next ready task → build → ship a PR → forward metrics, on a schedule or as a one-shot. |

Two cross-cutting concerns span all three:
- **CI gates** (`.github/workflows/ci.yml`) — lint → typecheck → `bun test` → secret-scan → task-store doctor (+ e2e/agent jobs), each merge-blocking, each with a local-parity command.
- **Local orchestration** (`Taskfile.yml`, go-task) — the single local entrypoint: `task dev` runs UI + API + agent together; `task ui`/`api`/`agent` run them independently; `task test`/`task ci` run the suite/gates.

## Before you commit — this repository is going public

This repo is **private today but destined to be a public, MIT open-source project.** Git history is permanent — anything committed and pushed can't be truly unpublished. **Scrub before the commit, not after the push.**

**The rule:** review every change before staging it; never commit content you haven't eyeballed for proprietary material. Stage specific files — never `git add -A`/`-u` blindly. When unsure whether something is proprietary, **ask before committing.**

**Scrub for (categories):**
- **Secrets & credentials** — API keys/tokens (PostHog personal API key, `ANTHROPIC_API_KEY`, `GH_TOKEN`), `SESSION_SECRET`, `.env` contents, private keys, OAuth tokens. Use env vars/placeholders, never literals.
- **Client / customer / partner names** and identifying engagement details — use generic placeholders.
- **Internal infrastructure identifiers** — cloud project names, analytics project IDs, cluster/namespace names, internal hostnames/URLs, deployment specifics.
- **Internal references** — internal PR/issue numbers, Slack/Jira/Linear links, internal-only doc links.
- **Local filesystem paths** revealing usernames/machine layout (e.g. `/Users/<name>/...`).
- **Financials, compensation, revenue, and any PII.**

The CI secret scan (`gitleaks`/`detect-secrets`) and a client-name audit are the final backstop — not a substitute for this discipline.

> Internal, build-time-only notes (kept out of public history) live in the git-ignored `CLAUDE.local.md`. Read it for operational context before working in this repo.

## How work is tracked

The task store is **GitHub Issues** in this repo, configured via `.shipwright.json` (`taskStore: "github"`). Work is planned as issues under the **`shipwright-oss`** milestone, each with a machine-readable ```` ```shipwright ```` YAML block (`id`, `layer`, `branch`, `dependencies`, `hours`, `status`, `pr`) and a `status:*` label.

**Find the next ready task:**
```bash
gh issue list --milestone shipwright-oss --state open --label status:pending
```

**Status lifecycle** (the label is the single signal of where a task is):
```
pending → in_progress → pr_open → merged → deployed → done
```
plus `approved`, `blocked`, `cancelled`.

### The execution loop

1. Pick a `status:pending` task whose every `dependencies` entry is `status:done`.
2. Branch from the task's YAML `branch` field (`feat/sw-x-y-slug`) — never work on `main`.
3. Build + land tests **in the same PR, at the correct layer** (no "tests later").
4. Open a PR; move the status label through its lifecycle.

Driven by Shipwright's own commands: `/shipwright:dev-task` (build + test + PR) → `/shipwright:review` / `/shipwright:patch` → `/shipwright:deploy`.

> ⚠️ **Task-store gotcha:** the backend is selected **only** by the `SHIPWRIGHT_CONFIG` env var pointing at `.shipwright.json` — there is **no auto-discovery**. If it's unset, Shipwright silently falls back to a local JSON store and no issues are filed. Set it in `.claude/settings.local.json` (`env.SHIPWRIGHT_CONFIG`, absolute path, git-ignored) and **restart the session**. If task operations seem to no-op, suspect this first.

## Conventions

- **Tests land with the code, at the correct layer** — same PR, no "add tests later" tasks:
  - **unit** — pure logic, no I/O.
  - **integration** — real dependency behavior via recorded fixtures / injected doubles.
  - **smoke** — Hono endpoints via in-process `app.request()` (no real socket).
  - **e2e** — the dashboard in a real browser via Playwright.
- **Test isolation:** inject time via a `Clock`; test external clients (PostHog, GitHub) with recorded fixtures. **No `mock.module()`, no `global.fetch`/`global.*` overrides** — Bun shares the test process, so leaked globals break sibling suites.
- **No new coupling:** the plugin stays repo-agnostic; the metrics service and the agent depend on no external platform service.
- **License:** MIT across all artifacts.
- **Local-first:** everything runs offline by default (fixtures / injected doubles / scratch queue); live external calls only when env explicitly enables them.

## Database env vars

Each service that uses Prisma reads its own `DATABASE_URL_*` env var — never a shared connection.

| Variable | Service | Schema |
|----------|---------|--------|
| `DATABASE_URL_AGENT` | `@shipwright/agent` | `agent/prisma/schema.prisma` |

Set `DATABASE_URL_AGENT` before running `task db:provision` or `task db:migrate`.
For local development a SQLite URL works: `DATABASE_URL_AGENT="file:./agent/dev.db"`.
For production use a PostgreSQL URL: `DATABASE_URL_AGENT="postgresql://user:pass@host:5432/agent"`.

> Note: the schema currently uses `sqlite` as the provider for local portability.
> Swap `provider = "sqlite"` to `provider = "postgresql"` in `agent/prisma/schema.prisma`
> and regenerate migrations when deploying against a real Postgres instance.

## Repository layout

This is the standalone home of Shipwright. Product code fills in across phases A → B → C; today the repo holds the open-source foundation — this file, `LICENSE`, `README.md`, `.gitignore`, and `.shipwright.json` — and its planning lives in [GitHub Issues](https://github.com/app-vitals/shipwright/issues).
