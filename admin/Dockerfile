# Shipwright Admin Service — container image
#
# Build from repo root:
#   docker build -f admin/Dockerfile -t shipwright-admin .
#
# Run:
#   docker run \
#     -e DATABASE_URL_SHIPWRIGHT_ADMIN=postgres://... \
#     -e SHIPWRIGHT_SESSION_SECRET=... \
#     -e GOOGLE_CLIENT_ID=... \
#     -e GOOGLE_CLIENT_SECRET=... \
#     -e SHIPWRIGHT_ADMIN_ALLOWED_EMAILS=admin@example.com \
#     -e SHIPWRIGHT_ADMIN_APP_BASE_URL=https://admin.example.com \
#     -p 3000:3000 \
#     shipwright-admin

# ─── Stage 1: dependencies ────────────────────────────────────────────────────
FROM oven/bun:1-slim AS deps

WORKDIR /app

# Copy workspace manifests for dependency install
COPY package.json bun.lock ./
COPY admin/package.json ./admin/
COPY admin/prisma ./admin/prisma/
# admin is on Prisma 7, where the datasource block no longer carries `url` — it
# lives in prisma.config.ts, which sits beside package.json rather than inside
# prisma/. `bun install` below runs admin's `postinstall: prisma generate`, so
# the config has to be in the deps stage too, not only in the `COPY . .` of the
# production stage.
COPY admin/prisma.config.ts ./admin/
COPY task-store/package.json ./task-store/
COPY task-store/prisma ./task-store/prisma/
COPY chat/package.json ./chat/
COPY chat/prisma ./chat/prisma/
COPY agent/package.json ./agent/
COPY metrics/package.json ./metrics/
COPY plugins/shipwright/package.json ./plugins/shipwright/
COPY agent/src/runtime/package.json ./agent/src/runtime/
COPY mcp-server/package.json ./mcp-server/
COPY patches/ ./patches/

RUN bun install --frozen-lockfile

# ─── Stage 2: production image ────────────────────────────────────────────────
FROM oven/bun:1-slim AS production

# Install system dependencies (ca-certificates only — no Claude Code, no gh CLI, no mise)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

# Copy hoisted + workspace-local node_modules from the deps stage. bun workspaces
# install package-specific deps under the workspace dir (/app/admin/node_modules),
# NOT the hoisted root — both are required at runtime. The root node_modules also
# carries bun's package store (node_modules/.bun), which is where the registry
# package @app-vitals/agent-lib (and its own deps, e.g. @sentry/bun) lives; the
# workspace-local @app-vitals/agent-lib entries are symlinks into it.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/admin/node_modules ./admin/node_modules

# Copy entire monorepo source
COPY . .

# Lib resolution guard (AGR-4.1): resolve every @app-vitals/agent-lib/* and
# import of the service from the final filesystem, so an image
# missing the registry package fails here instead of crash-looping at
# boot (the 0.100.0 class).
RUN bun agent/scripts/check-lib-resolution.ts --require @app-vitals/agent-lib admin/src

# Generate Prisma client
RUN cd admin && bunx prisma generate --schema=prisma/schema

EXPOSE 3000

# Run as a non-root user. The GKE deployment sets `runAsNonRoot: true`, and the
# kubelet can only verify that when the image's USER is a numeric UID (it does
# not read the image's /etc/passwd). uid 1000 is the `bun` user baked into the
# oven/bun base image. Without this the container is refused at admission with
# "container has runAsNonRoot and image will run as root".
USER 1000

ENTRYPOINT ["bun", "run", "admin/src/main.ts"]
