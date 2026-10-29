# Local cross-repo development

The agent platform lives in [app-vitals/agent](https://github.com/app-vitals/agent); Shipwright consumes it as exact-pinned registry packages (`@app-vitals/agent-runtime`, `@app-vitals/agent-admin`, `@app-vitals/agent-lib`) and as the `ghcr.io/app-vitals/agent` base image (`ARG PLATFORM_VERSION` in `agent/Dockerfile`). When a change spans both repos, link your local platform checkout into Shipwright instead of publishing a release.

The packages ship TypeScript source with an `exports` map and Bun runs it directly, so a link needs no build step.

## 1. Link the platform packages

Check out `app-vitals/agent` next to this repo, then register each package once and link it into Shipwright:

```bash
# in the platform checkout
(cd runtime && bun link)
(cd admin && bun link)
(cd lib && bun link)

# in this repo (after `bun install`)
bun link @app-vitals/agent-runtime @app-vitals/agent-admin @app-vitals/agent-lib
```

Rules of thumb:

- Never commit the link. Keep `package.json` and `bun.lock` on the exact registry pins; run `git status` before committing. A plain `bun install` replaces the links with the registry versions, which is also how you unlink.
- `@app-vitals/agent-admin` ships a generated Prisma client. After pulling platform schema changes run its `db:generate` script in the platform checkout (`cd admin && bun run db:generate`).
- Link all three packages together. Mixing a linked package with a registry copy of another gives two copies of `agent-lib`, which the pin tests and `agent/scripts/check-lib-resolution.ts` exist to catch.

## 2. What picks the link up

| Flow | Platform code it uses | With the link |
|---|---|---|
| `task dev` (metrics supervisor) | `@app-vitals/agent-lib` | Edits are live. |
| `task hitl` (`scripts/hitl.ts`) | `agent-runtime` (`claude`, `setup`), `agent-admin` (Prisma client, `prisma.config.ts`), `agent-lib` | Edits are live; the admin it boots is `admin/src/main.ts` on top of the linked `agent-admin`. |
| `scripts/seed-dev-agent.ts` | `agent-admin` (`prisma-client`, `specialty-manifest-loader`), `agent-lib` | Edits are live; regenerate the Prisma client first if the schema changed. |
| `task stack` (tmux; agent in Docker) | Host processes use the link. The agent container is built from `agent/Dockerfile`, which starts `FROM ghcr.io/app-vitals/agent:${PLATFORM_VERSION}`. The `chat-svc` pane runs the platform's `chat/src/main.ts` (or the `agent-chat` image). | The container does **not** see the link. Build the platform image locally first (below). The chat pane reads the platform checkout directly (next section). |
| `task minikube:*` | Images pulled by the chart (`ghcr.io/app-vitals/shipwright-*`) | The link does not apply. Load locally built images (below). |

### Running chat (`task stack`)

The chat service is hosted in the platform repo, not in this one. The `chat-svc` pane (`:3003`) starts it one of two ways:

- **Platform checkout (default).** Runs `chat/src/main.ts` from the checkout at `$AGENT_PLATFORM_DIR` (default `../agent`, the sibling checkout from step 1):

  ```bash
  (cd ../agent && bun install)   # postinstall generates chat's Prisma client
  AGENT_PLATFORM_DIR=/path/to/agent task stack   # only if it is not at ../agent
  ```

  `task stack` fails fast with a pointer to this page if the checkout is missing.
- **Published image.** Set `SHIPWRIGHT_CHAT_IMAGE` to run `ghcr.io/app-vitals/agent-chat:<platform version>` instead (the tag matches `ARG PLATFORM_VERSION` in `agent/Dockerfile`). The container reaches the host Postgres via `host.docker.internal`; `task stack:down` removes it.

  ```bash
  SHIPWRIGHT_CHAT_IMAGE=ghcr.io/app-vitals/agent-chat:<PLATFORM_VERSION> task stack
  ```

Either way chat uses its own dedicated database, `shipwright_chat_dev` on the local Postgres (`DATABASE_URL_SHIPWRIGHT_CHAT`), and runs `prisma migrate deploy` itself on boot, so `task stack` has no chat migration preflight. `scripts/seed-chat-tokens.ts` (run from the agent pane once you have created an agent) inserts the dev admin and agent tokens into that database's `ChatToken` table over plain SQL and waits for chat's boot migration to create it, so it works with either source. Shipwright CI no longer creates or migrates a chat database; chat's own tests run in the platform repo.

For Minikube the chart's `chat` workload still defaults to `ghcr.io/app-vitals/shipwright-chat`; to run the platform build, side-load or point `chat.image.repository`/`chat.image.tag` at the `agent-chat` image (section 3 describes the same approach for the agent image).

## 3. Running a local platform image

To exercise runtime changes inside the agent container, build the platform image from the platform checkout and tag it with the version `agent/Dockerfile` expects, so the Shipwright build resolves it locally instead of pulling the published one:

```bash
# in the platform checkout (build from its repository root)
docker build -f runtime/Dockerfile -t ghcr.io/app-vitals/agent:<PLATFORM_VERSION> .

# in this repo
task stack          # or: docker build -f agent/Dockerfile -t shipwright-agent:ci .
```

`<PLATFORM_VERSION>` is the `ARG PLATFORM_VERSION` default in `agent/Dockerfile`. Do not pass `--pull`, or Docker fetches the published image over your local tag. For Minikube, build the Shipwright image the same way and side-load it (`minikube image load <image>`), then set the chart's `agent.image.repository` and `agent.image.tag` values to it.

The admin image does not use the platform admin image: `admin/Dockerfile` installs `@app-vitals/agent-admin` from `bun.lock` and layers `admin/src/main.ts` on it.

## 4. Shipping the change

1. Land the platform change in `app-vitals/agent`; its release workflow publishes the packages and image and dispatches `platform-release` to this repo.
2. `.github/workflows/platform-release.yml` opens (or updates) the `chore/platform-release` PR that re-pins every `@app-vitals/agent-*` dependency, `ARG PLATFORM_VERSION` in `agent/Dockerfile`, `bun.lock` and the `docs/platform/` snapshot. Before `bun install` runs, the workflow waits (up to ~10 minutes) for those exact packages to appear on npm, which lags the publish; `bun scripts/platform-release-bump.ts --list-packages` prints the package names it waits on. Renovate's `app-vitals agent platform` group is the fallback.
3. After that PR merges, `build-agent.yml` tags and pushes a new `shipwright-agent` `agent-vX.Y.Z` image (the pin files are in its path filter).

Platform docs under `docs/platform/` are a read-only snapshot refreshed only by the bump PR (`platform-docs-guard.yml`); edit them upstream.
