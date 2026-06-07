# Toolchain Detection Patterns

Lookup table for auto-detecting project toolchains from config files. Used by all Shipwright commands at startup.

## Detection Order

Scan the project root for these files in priority order. A project may match multiple ecosystems (e.g., Node.js + Rust in a monorepo).

## Node.js

| Signal | Detection |
|--------|-----------|
| `package-lock.json` | npm |
| `yarn.lock` | yarn |
| `pnpm-lock.yaml` | pnpm |
| `bun.lockb` or `bun.lock` | bun |
| `package.json` (no lockfile) | npm (fallback) |

**Commands** — read from `package.json` `scripts` field:

| Script Key | Purpose | Fallback |
|------------|---------|----------|
| `validate` | Full validation (lint + types + tests + build) | Run `lint`, `typecheck`, `test`, `build` individually |
| `build` | Build/compile | `tsc` if `tsconfig.json` exists |
| `test` | Unit tests | `vitest run` or `jest` based on devDependencies |
| `lint` | Linting | `eslint .` if eslint config exists |
| `typecheck` or `check` | Type checking | `tsc --noEmit` if TypeScript |
| `format` | Code formatting | `prettier --check .` if prettier config exists |

**Monorepo detection:**
- `pnpm-workspace.yaml` → pnpm workspaces
- `package.json` → `workspaces` field (npm/yarn workspaces)
- `lerna.json` → Lerna monorepo
- `nx.json` → Nx monorepo
- `turbo.json` → Turborepo

**Per-package commands** (monorepo): `{manager} --filter {package} {script}`

## Rust

| Signal | Detection |
|--------|-----------|
| `Cargo.toml` | Cargo |
| `Cargo.lock` | Confirms Rust project |

| Command | Purpose |
|---------|---------|
| `cargo build` | Build |
| `cargo test` | Tests |
| `cargo clippy --workspace -- -D warnings` | Lint |
| `cargo fmt --check` | Format check |
| `cargo doc --no-deps` | Documentation |

**Workspace detection:** `[workspace]` section in root `Cargo.toml`

## Go

| Signal | Detection |
|--------|-----------|
| `go.mod` | Go modules |
| `go.sum` | Confirms Go project |

| Command | Purpose |
|---------|---------|
| `go build ./...` | Build |
| `go test ./...` | Tests |
| `go vet ./...` | Vet |
| `golangci-lint run` | Lint (if installed) |
| `gofmt -l .` | Format check |

**Workspace detection:** `go.work` file

## Java

| Signal | Detection |
|--------|-----------|
| `pom.xml` | Maven |
| `build.gradle` | Gradle (Groovy DSL) |
| `build.gradle.kts` | Gradle (Kotlin DSL) |
| `gradlew` | Gradle wrapper (prefer over global `gradle`) |
| `mvnw` | Maven wrapper (prefer over global `mvn`) |

**Commands** — prefer wrapper scripts when present:

| Tool | Build | Test | Lint | Format check |
|------|-------|------|------|--------------|
| Maven (wrapper) | `./mvnw package -DskipTests` | `./mvnw test` | `./mvnw checkstyle:check` | — |
| Maven (global) | `mvn package -DskipTests` | `mvn test` | `mvn checkstyle:check` | — |
| Gradle (wrapper) | `./gradlew build -x test` | `./gradlew test` | `./gradlew checkstyleMain` | `./gradlew spotlessCheck` |
| Gradle (global) | `gradle build -x test` | `gradle test` | `gradle checkstyleMain` | `gradle spotlessCheck` |

**Profile/variant detection:**
- Check `pom.xml` for `<profiles>` — integration tests often live behind `-Pintegration` or `-Pit`
- Check `build.gradle` / `build.gradle.kts` for `sourceSets` blocks — acceptance tests may be in a separate source set (e.g., `acceptanceTest`, `integrationTest`)
- Check for `src/test/`, `src/integrationTest/`, `src/acceptanceTest/` directories

**Multi-module detection:**
- Maven: root `pom.xml` with `<modules>` section
- Gradle: `settings.gradle` or `settings.gradle.kts` with `include(...)` statements

**Mixed-language test suites** (common in Java projects):
- `src/test/` in Java + `playwright.config.*` or `package.json` with Playwright → TypeScript E2E tests alongside Java unit tests
- `requirements.txt` / `pyproject.toml` at root or in `tests/` → Python acceptance tests (e.g., pytest + requests)
- In these cases, detect both ecosystems and run each test suite independently

## Python

| Signal | Detection |
|--------|-----------|
| `pyproject.toml` | Modern Python (check `[build-system]` for tool) |
| `setup.py` / `setup.cfg` | Legacy Python |
| `requirements.txt` | pip |
| `Pipfile` | pipenv |
| `poetry.lock` | Poetry |
| `uv.lock` | uv |

| Tool | Build | Test | Lint | Format |
|------|-------|------|------|--------|
| Poetry | `poetry build` | `poetry run pytest` | `poetry run ruff check` | `poetry run ruff format --check` |
| uv | `uv build` | `uv run pytest` | `uv run ruff check` | `uv run ruff format --check` |
| pip | `python -m build` | `pytest` | `ruff check` | `ruff format --check` |

**Monorepo detection:** Multiple `pyproject.toml` files in subdirectories

## Ruby

| Signal | Detection |
|--------|-----------|
| `Gemfile` | Bundler |
| `Gemfile.lock` | Confirms Ruby project |
| `*.gemspec` | Gem project |

| Command | Purpose |
|---------|---------|
| `bundle exec rake build` | Build (if Rakefile) |
| `bundle exec rspec` | Tests (RSpec) |
| `bundle exec rake test` | Tests (Minitest) |
| `bundle exec rubocop` | Lint |
| `bundle exec standardrb` | Lint (Standard) |

## Generic / Makefile

| Signal | Detection |
|--------|-----------|
| `Makefile` | Make-based project |

Scan for common targets: `build`, `test`, `lint`, `check`, `clean`, `install`

| Command | Purpose |
|---------|---------|
| `make build` | Build |
| `make test` | Test |
| `make lint` | Lint |
| `make check` | Full check |

## Bun-Specific Gotchas

### `bunx` vs local binary — always prefer local after `bun install`

`bunx` checks `node_modules/.bin` first and uses the local binary when present. However, if the package is **not** installed locally (e.g., before `bun install`, in a fresh CI environment, or in a Docker build stage without `node_modules`), `bunx` silently fetches the **latest version** from the npm registry — ignoring whatever version `package.json` or `bun.lock` specifies. This silent fallback is the gotcha:

```bash
# RISKY — silently fetches latest if node_modules is missing or incomplete
bunx prisma migrate dev

# SAFE — fails loudly if not installed, uses pinned version if installed
bun run db:migrate           # via package.json scripts
# OR
./node_modules/.bin/prisma migrate dev
```

**Practical impact**: A project with `"prisma": "^6.0.0"` in `package.json` will get Prisma v7.x from `bunx` if `node_modules` is missing and v7 is the latest — potentially breaking the schema syntax (Prisma v7 dropped `url` in `schema.prisma`, requiring `prisma.config.ts`).

**Rule for Shipwright**: Always use `bun run <script>` or `./node_modules/.bin/<binary>` for tools that have strict version pinning. These approaches fail loudly when `node_modules` is missing rather than silently fetching a potentially incompatible version. Never use `bunx` for database tooling, schema generators, or any tool where a major version bump would break the project.

> Note: `bunx` is fine for one-off tools not pinned in `package.json` (e.g., `bunx create-hono`).

### Prisma migrations must run synchronously — never in background

`prisma migrate dev` is interactive and long-running. Running it as a background task causes it to time out or receive SIGTERM (exit code 143):

```bash
# WRONG — times out as a background task
run_in_background("./node_modules/.bin/prisma migrate dev --name init")

# CORRECT — run synchronously, wait for completion
bun run db:migrate    # via package.json scripts
# OR
./node_modules/.bin/prisma migrate dev --name init
```

**Rule for Shipwright**: Always run `prisma migrate dev` as a foreground synchronous command. For applying existing migrations (e.g., after pulling new migration files from a teammate), use `prisma migrate deploy` instead — it's non-interactive and faster.

---


## Multi-Ecosystem Projects

Some projects use multiple ecosystems. When this happens:
1. Detect all ecosystems present
2. Run validation commands for each ecosystem
3. Report results per-ecosystem in coverage and pre-ship checks

Example: A project with `package.json` + `Cargo.toml` runs both `pnpm validate` and `cargo test`.

## Permission Patterns

Map detected tools to Bash permission patterns for `.claude/settings.local.json`:

| Tool | Pattern |
|------|---------|
| git | `Bash(git:*)` |
| GitHub CLI | `Bash(gh:*)` |
| pnpm | `Bash(pnpm:*)` |
| npm | `Bash(npm:*)` |
| yarn | `Bash(yarn:*)` |
| bun | `Bash(bun:*)` |
| cargo | `Bash(cargo:*)` |
| go | `Bash(go:*)` |
| mvn / mvnw | `Bash(mvn:*)`, `Bash(./mvnw:*)` |
| gradle / gradlew | `Bash(gradle:*)`, `Bash(./gradlew:*)` |
| python/pytest | `Bash(python:*)`, `Bash(pytest:*)` |
| poetry | `Bash(poetry:*)` |
| uv | `Bash(uv:*)` |
| bundle | `Bash(bundle:*)` |
| make | `Bash(make:*)` |
| npx | `Bash(npx:*)` |
| node | `Bash(node:*)` |
| Shell utilities | `Bash(wc:*)`, `Bash(find:*)`, `Bash(grep:*)` |
| playwright | `Bash(npx playwright:*)` |

## E2E Testing Detection

When a project has a UI/frontend layer, Playwright E2E tests should be included in the plan. Detection signals:

| Signal | Indicates UI |
|--------|-------------|
| `src/frontend/`, `src/app/`, `src/pages/`, `src/components/` | Frontend directories |
| `index.html`, `*.html` in src | Web app entry point |
| `leaflet`, `react`, `vue`, `svelte`, `angular`, `solid` in deps | UI framework |
| `vite`, `webpack`, `parcel`, `esbuild` in devDeps | Frontend bundler |
| Browser extension manifest (`manifest.json` with `manifest_version`) | Browser extension |
| `tauri.conf.json`, `electron-builder.yml` | Desktop app with webview |

When UI detected, add `@playwright/test` to the toolchain and include E2E test tasks in the breakdown.
