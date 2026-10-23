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

- Relative specifiers (`./x`, `../../y`) and `@shipwright/*` workspace specifiers must resolve to a file inside the set.
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
