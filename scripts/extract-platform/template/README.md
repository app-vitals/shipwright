# App Vitals Agent

An open-source platform for running always-on AI agents: the agent runtime, the admin service that provisions and configures agents, and the libraries they share.

| Directory | Package | What it is |
|---|---|---|
| `runtime/` | `@app-vitals/agent-runtime` | The agent process: startup sequence, Slack and cron handling, Claude Code sessions, health probe |
| `admin/` | `@app-vitals/agent-admin` | CRUD API and UI for agents, env vars, cron jobs, tokens, tools and plugins (Hono + Prisma + Postgres) |
| `lib/` | `@app-vitals/agent-lib` | Small modules shared by the runtime and the admin |
| `agent-types/` | | Agent-type definitions and the JSON schema they validate against |

All three packages ship TypeScript source and are MIT licensed.

## Images

| Image | Dockerfile |
|---|---|
| `ghcr.io/app-vitals/agent` | `runtime/Dockerfile` |
| `ghcr.io/app-vitals/agent-admin` | `admin/Dockerfile` |

Build either one from the repository root:

```bash
docker build -f runtime/Dockerfile -t agent .
docker build -f admin/Dockerfile -t agent-admin .
```

### Building on the runtime image

Downstream images build `FROM` the runtime image. The contract they can rely on:

- A Claude Code marketplace copied to `/opt/shipwright/marketplaces/<name>/` is registered at boot by `installPlugins()` (`runtime/setup.ts`).
- The entrypoint is `bun run /app/runtime/entrypoint-main.ts`, which spawns `/app/index.ts`. A downstream image that adds behavior replaces `index.ts` with one that passes its extensions to `startAgent()`.

CI enforces the contract with `runtime/base-image-contract.smoke.test.ts`.

## Development

```bash
bun install
bun run lint
bun run typecheck
bun run check:boundary   # no import may leave runtime/, admin/, lib/ and agent-types/
bun test
```

Integration tests that need Postgres read `DATABASE_URL_ADMIN_TEST` and skip when it is unset.

## License

[MIT](./LICENSE)
