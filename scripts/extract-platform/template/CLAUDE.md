# CLAUDE.md

Guidance for AI coding agents working in this repository.

## Layout

- `runtime/` (`@app-vitals/agent-runtime`): the agent process. `runtime/entrypoint-main.ts` is the container entrypoint; it runs the startup sequence and spawns `index.ts`.
- `admin/` (`@app-vitals/agent-admin`): admin API and UI. `admin/src/main.ts` is its composition root.
- `agent-types/`: agent-type definitions and their JSON schema.
- `index.ts`: the agent server composition root (`startAgent([])`).

## Commands

```bash
bun install
bun run lint            # bunx biome lint .
bun run typecheck       # tsc --noEmit
bun run check:boundary  # import-boundary gate
bun test                # single file: bun test path/to/file.test.ts
```

`bun test --filter` is not a real flag; pass file paths.

## Conventions

- Conventional Commits for commits and PR titles (squash merge; semantic-release reads the title).
- Tests land with the code: `*.unit.test.ts`, `*.integration.test.ts`, `*.smoke.test.ts`.
- Imports must stay inside this repository. Use `@app-vitals/agent-runtime/*` and `@app-vitals/agent-admin` for cross-package imports. Shared modules come from the pinned `@app-vitals/agent-lib` registry package (`@app-vitals/agent-lib/*`).
- The generated Prisma client (`admin/prisma/client`) is never committed; `bunx prisma generate --schema=prisma/schema` in `admin/` creates it.
- `runtime/Dockerfile` keeps the module-resolution guard (a `bun build` over every runtime source file) and the base-image contract (`/opt/shipwright/marketplaces/`, `installPlugins()`, the entrypoint path). Change them only together with `runtime/base-image-contract.smoke.test.ts`.
- Never hand-edit `CHANGELOG.md` or version fields; releases are automated.
