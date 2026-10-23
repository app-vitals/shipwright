# Platform manifest and the copy-paste-readiness gate

> The platform manifest lists the files that would move to a separate repository when the agent runtime and admin are extracted. A bun test walks the import closure of that set and fails on any import that leaves it, so the set stays copyable.

## Overview

The agent runtime, the admin service and the provisioning code form a "platform set". Shipwright's coding behavior (the coding agent extension, the coding admin extension, the task store, the plugins) sits on top of it. The set must keep depending on nothing but itself, a short list of shared `lib` modules and npm packages. Otherwise moving it means untangling imports at extraction time instead of copying files.

Three files make up the gate:

| File | Role |
|---|---|
| `platform-manifest.json` | The set: globs to include and exclude, the `lib` modules it needs, composition roots, generated paths and the (empty) exemption list. |
| `scripts/platform-gate.ts` | The closure walker. Pure functions, unit-tested with a fixture tree in `scripts/platform-gate.unit.test.ts`. |
| `platform-manifest.unit.test.ts` | Runs the walker against the real repo and the real manifest. Part of `bun test` and so part of `task ci`. |

The gate is behavior-preserving. It adds no runtime code and does not touch the base-image contract (image name and tag scheme, `/opt/shipwright/marketplaces/`, `installPlugins()`, the entrypoint path).

## What the manifest lists

- `agent/src/runtime/**` and the agent test fixtures in `agent/src/fixtures/**`.
- The thin entry `agent/src/entrypoint-main.ts`, `agent/Dockerfile`, and the runtime workspace templates in `agent/workspace/` (the coding variants `CLAUDE.md.template` and `CLAUDE-HITL.md.template` are excluded).
- `admin/**` except `admin/src/coding/**` (the coding admin extension and its tests) and the generated Prisma client.
- The Specialty schema artifact (`docs/schemas/specialty.schema.json`) and the neutral default type, `specialties/specialist/**`. The `coding` manifest stays with Shipwright.
- The platform ships no coding content. Its tests run against a minimal fixture specialty (see [Self-contained without the coding specialty](#self-contained-without-the-coding-specialty)).
- Tests that assert genuinely coding behavior stay in Shipwright: they sit in `exclude` (or, for tests of Shipwright's composition, `compositionRoots`), are not extracted, and keep running in the monorepo.
- The `lib` modules the set imports, each with a tag.

### Composition roots

`agent/src/index.ts` and `admin/src/main.ts` wire the coding extension into the platform, so they import `coding/` by design. They stay with the consumer and are not in the set. Files that exist only to test that composition are listed with them in `compositionRoots` (each with a reason). A set file that imports a composition root is still a violation.

### Lib module tags

Every module under `lib/` that the set imports must appear in the `lib` table:

```json
{ "module": "pg-sslmode", "tag": "shared", "sharedWith": ["task-store", "chat"] }
```

- `platform-only`: nothing outside the set imports it. `sharedWith` must be empty.
- `shared`: also imported from outside the set. `sharedWith` lists who, from `coding`, `task-store`, `chat`, `metrics`, `mcp-server` or `lib` (another lib module outside the set).

The tags are checked against the repo, not just declared: the test fails if a platform-only module gains an outside importer, if a shared module gains a consumer that is not listed, or if a listed consumer no longer imports it. Importers under `docs/`, `site/` and `planning/` do not count.

The gate only records which modules are shared. Whether they are copied, published as a package or consumed from the platform repo stays a decision for the extraction itself.

## What the gate checks

For every file in the set (tests included), the walker reads each module specifier: `import`, `import type`, `export ... from`, side-effect `import "x"`, dynamic `import("x")`, `require("x")` and `mock.module("x")`. Comments and string contents are ignored.

- Relative specifiers (`./x`, `../../y`), `@shipwright/*` workspace specifiers and `@app-vitals/agent-runtime/*` (resolved to `agent/src/runtime/*`) and `@app-vitals/agent-admin[/*]` (resolved per `admin/package.json`'s exports map: the root to `admin/src/server.ts`, specs/Prisma files to `admin/`, everything else to `admin/src/`) must resolve to a file inside the set.
- `@app-vitals/agent-lib/*` (or a relative path into `lib/`) must name a listed `lib` module.
- Imports of a path matching `generated` (the git-ignored Prisma client) count as inside the set.
- npm packages and `node:`/`bun:` builtins are not edges.

Violations carry one of these reasons: `outside-set`, `unlisted-lib-module`, `missing-lib-module` (listed but absent) or `unresolved`.

### Exemptions

`exemptions` must be empty, and `platform-manifest.unit.test.ts` asserts it. The field exists so any future exemption is a visible diff that a reviewer has to defend. Fix the import instead: move the shared piece into the set or a listed `lib` module, or move the consuming file out of the set.

## Running it

```bash
bun test platform-manifest.unit.test.ts scripts/platform-gate.unit.test.ts
```

A failure prints one line per edge, for example:

```
agent/src/runtime/clock.ts -> ../../../task-store/src/index.ts (task-store/src/index.ts) [outside-set]
```

## Extracting the set

`scripts/extract-platform.ts` turns the manifest into the `app-vitals/agent` tree in an output directory. It is re-runnable by design: the pipeline keeps merging, so a one-shot cut is stale within hours. It never pushes and never modifies the source repository.

```bash
bun scripts/extract-platform.ts --out /tmp/agent-extract              # history mode (default)
bun scripts/extract-platform.ts --out /tmp/agent-extract --no-history # copy only, fast rehearsal
```

| Flag | Meaning |
|---|---|
| `--out <dir>` | Output directory (required). Refuses a non-empty directory unless `--clean`. |
| `--no-history` | Copy the files only, no git repository. |
| `--ref <rev>` | Source commit to extract (default `HEAD`). |
| `--source <repo>` | Source repository (default: this one). |
| `--clean` | Delete the output directory first. |

Layout of the output:

| Source | Extracted |
|---|---|
| `agent/src/runtime/**`, `agent/src/fixtures/**` (to `runtime/fixtures/`), `agent/src/entrypoint-main.ts`, `agent/Dockerfile`, `agent/workspace/**` | `runtime/` |
| `admin/**` | `admin/` |
| the listed `lib` modules and `lib/package.json` | `lib/` |
| `specialties/specialist/**`, `docs/schemas/specialty.schema.json` | `agent-types/` |
| `scripts/extract-platform/template/**` | the tree root (see below) |

The file list is the gate's own (`collectSetFiles`), read from the exported commit rather than the working tree, so untracked files, `worktrees/` and the generated Prisma client never appear. In history mode the script runs `git filter-repo` over those paths with `--path-rename`, then commits the rewrite of relative specifiers, the `@shipwright/` scope and tsconfig/package.json path values as one commit with a fixed author and date. The same source commit therefore gives the same tree and the same commit hashes.

The rewrite only sees module specifiers and JSON path values, plus the absolute container paths listed in `STRING_REWRITES` (`/app/agent/src/runtime/` and `/app/agent/src/entrypoint-main.ts`, which the base-image contract smoke test addresses). Other paths inside strings are not rewritten.

### The standalone-repo template

`scripts/extract-platform/template/` holds the files the new repository needs that have no source here. `extract-platform.ts` copies it over the extracted tree after the rewrite, in both modes; in history mode it lands in the same fixed-identity commit, so the result stays deterministic. A template file wins over an extracted file at the same path.

| Group | Files |
|---|---|
| Root config | `package.json` (workspaces `runtime`, `admin`, `lib`), `tsconfig.json`, `biome.json`, `bunfig.toml`, `.gitignore`, `.dockerignore`, `.releaserc.json`, `renovate.json`, `patches/` |
| Docs and license | `LICENSE` (MIT), `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CLAUDE.md` |
| Workflows (`.github/workflows/`) | `ci.yml` (lint, typecheck, import-boundary gate, tests, admin and runtime docker builds, browser-launch check, base-image contract smoke), `pr-title-lint.yml`, `release.yml` (semantic-release) |
| Images | `runtime/Dockerfile` (`ghcr.io/app-vitals/agent`) and `admin/Dockerfile` (`ghcr.io/app-vitals/agent-admin`); neither copies `task-store/`, `chat/`, `plugins/`, `metrics/` or `mcp-server/`. The runtime image keeps the module-resolution guard and the base-image contract (`/opt/shipwright/marketplaces/`, `installPlugins()`, `/app/runtime/entrypoint-main.ts`). |
| Composition roots | `index.ts` (`startAgent([])`, the process `runtime/entrypoint.ts` spawns) and `admin/src/main.ts` (`startAdmin([])`), replacing the excluded Shipwright roots |
| Scripts | `scripts/check-import-boundary.ts` (the gate ported from `platform-gate.ts`, run by `bun run check:boundary`), `scripts/test-env-preload.ts` (points tests at the fixture specialty), `scripts/verify-browser-launch.ts`, `scripts/bin/git-credential-shipwright.sh` |

A template file ending in `.tmpl` is copied without the suffix. `biome.json` is stored as `biome.json.tmpl` because Biome rejects a nested root configuration. The template directory is excluded from Renovate in this repository, and it holds no `*.test.ts` files, so root `bun test` does not pick it up. `scripts/extract-platform/template.unit.test.ts` pins the file set, bans internal strings from it, checks every `COPY` source of both Dockerfiles against a real extraction and runs the boundary gate on that tree.

### Dev dependency

History mode needs [`git-filter-repo`](https://github.com/newren/git-filter-repo) (`pip install git-filter-repo`). `--no-history` does not. The history integration test skips when it is missing.

## Pre-publication audit

Public repositories keep every ref forever, so before the extracted tree is pushed, run `scripts/audit-extraction.ts` (AGR-2.1) against it. It exits `1` on any finding, `0` when clean, `2` on a usage error.

```bash
bun scripts/extract-platform.ts --out /tmp/agent-extract --clean
bun scripts/audit-extraction.ts /tmp/agent-extract                 # or: task audit-extraction -- /tmp/agent-extract
bun scripts/audit-extraction.ts /tmp/agent-extract --history-banned --report audit.json
```

| Check | What it looks for |
|---|---|
| Secrets | `gitleaks detect --log-opts=--all` when `gitleaks` is on PATH (a notice is printed otherwise), plus a built-in scanner over the working tree and every added line of `git log --all -p`: AWS keys, GitHub tokens, Slack tokens, private-key blocks, Anthropic keys and high-entropy `api_key = "..."` assignments. |
| Banned strings | `BANNED_RULES` (internal product name, private `app-vitals/*` repos, internal hostnames, GCP identifiers, internal env-var prefix) over every working-tree file, docs and test fixtures included; `--history-banned` adds history. `BANNED_ALLOWLIST` (public `app-vitals/*` repos, `example.*` / `.test` hosts) suppresses a match only when it lies inside an allowed span. Add a rule or allow entry in `scripts/audit-extraction.ts` with a unit-test fixture. |
| License | `LICENSE` at the root is the MIT text, root `package.json` has `"license": "MIT"`, no other `package.json` declares a different license. |
| Artifacts | `node_modules`, `dist`/`build`, `*.tsbuildinfo`, `coverage`, `.env*` (not `.env.example`), `worktrees/` and nested `.git` in the tree and anywhere in history (`git log --all --name-only`). |

Each finding is `{ rule, file, commit, line?, excerpt }`; `commit` is a sha or `working-tree`, and secret values are always redacted in `excerpt`. A tree without `.git` (a `--no-history` extraction) is audited as a working tree only, with a notice. Run it against the history-mode extraction for the real pre-publication gate.

## Self-contained without the coding specialty

The extracted tree excludes `specialties/coding/` and the coding workspace templates (`agent/workspace/CLAUDE.md.template`, `CLAUDE-HITL.md.template`), yet the runtime defaults to the `coding` specialty. So the platform tests must not need either one (AGR-1.9).

- **Fixture specialty.** `agent/src/fixtures/specialties/fixture/` (extracted to `runtime/fixtures/specialties/fixture/`) holds a minimal manifest and the three persona templates (`CLAUDE`, `SOUL`, `IDENTITY`) under `templates/`. Its `identity.templatesDir` is `templates/`: a relative path is tried against the repo root first, then against the manifest's own directory, so the specialty works wherever it is mounted.
- **Test environment.** The extracted tree's `bunfig.toml` preloads `scripts/test-env-preload.ts` (from `scripts/extract-platform/template/`), which sets `SHIPWRIGHT_SPECIALTIES_DIR` to the fixture directory and `SHIPWRIGHT_DEFAULT_AGENT_TYPE` to `fixture` unless already set. The monorepo leaves both unset, so it still defaults to `coding`. Tests that need "the default type" read it from the environment (for example `getSelfServeSpecialty()` now falls back to `SHIPWRIGHT_DEFAULT_AGENT_TYPE`) rather than hard-coding `coding`.
- **Coding-behavior tests stay home.** These are listed in `exclude`, so they are not extracted, and still run and pass in the monorepo: `setup.templates.integration.test.ts` and `setup.layered.integration.test.ts` (golden coding seeding, the coding template split), `specialty-manifest-loader.integration.test.ts` (loads the committed `coding` manifest) and `specialties/specialist/manifest.content.test.ts` (compares against `coding`). `admin/src/main.composition.unit.test.ts` is a composition-root entry. Their platform-neutral replacements are `setup.fixture.integration.test.ts` and `specialty-manifest-loader.fixture.integration.test.ts`.
- **Missing default.** When the default specialty cannot be loaded, `SpecialtyRegistry` throws an error naming the directory it looked in and `SHIPWRIGHT_SPECIALTIES_DIR` / `SHIPWRIGHT_DEFAULT_AGENT_TYPE`. The workspace seeder's `Missing workspace template` error names them too.

## Extending the manifest

- **New platform file under an included directory:** nothing to do. It is picked up by the globs and checked.
- **New file that should move:** add its path or glob to `include`.
- **New coding-only file inside a platform directory:** move it under `admin/src/coding/` or `agent/src/coding/`, or add an `exclude` glob. An excluded file can no longer be imported by the set.
- **New `lib` import in the set:** add the module to the `lib` table with its tag. The test names the module and who else imports it.
- **New composition file:** add it to `compositionRoots` with a reason.

## Limits

The gate sees imports. It does not see:

- `COPY` lines in Dockerfiles. `admin/Dockerfile` and `agent/Dockerfile` still copy `task-store/`, `chat/`, `plugins/` and other workspace manifests so `bun install` works in this monorepo.
- Files read at runtime or in tests by path (for example `admin/src/admin-boot.boot-order.unit.test.ts` reads `main.ts` as text).
- Root configuration that names the set's paths: `package.json` workspaces, `tsconfig.json` and `agent/tsconfig.json` path aliases, CI workflows and the Helm chart.

These are tracked in `planning/agent-runtime-extraction-prep/ADMIN-AUDIT.md` (section 6) and are handled at extraction time.
