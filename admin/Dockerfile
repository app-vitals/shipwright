# Shipwright Admin Service — container image
#
# The platform admin (API, UI, Prisma schema and migration history) is the
# registry package @app-vitals/agent-admin, installed from bun.lock at the
# version admin/package.json pins. This image adds only Shipwright's
# composition root (admin/src/main.ts) and coding extension (admin/src/coding)
# on top of it, plus the repo files they read at runtime
# (plugins/shipwright/references/).
#
# It is not layered FROM ghcr.io/app-vitals/agent-admin: that image is a
# runnable platform admin with its own workspace layout and its own
# node_modules, and the coding extension has to resolve the same
# @app-vitals/agent-admin, agent-lib and hono copies Shipwright's lockfile
# pins. Installing the package here keeps one copy of each.
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
COPY task-store/package.json ./task-store/
COPY task-store/prisma ./task-store/prisma/
COPY agent/package.json ./agent/
COPY metrics/package.json ./metrics/
COPY plugins/shipwright/package.json ./plugins/shipwright/
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

# Platform package guard (AGR-4.2): the composition root imports the platform
# admin from @app-vitals/agent-admin, so fail the build if it does not resolve
# from admin/ in the shipped filesystem.
RUN cd admin && bun -e 'import.meta.resolve("@app-vitals/agent-admin/admin-boot")'

# startAdmin() reads the app version (the service worker's cache name) from
# version.txt two levels above its own src/ — inside node_modules now that it
# is a package, where no version.txt exists, so it would fall back to "0.0.0".
# Put Shipwright's version.txt where the package looks for it.
RUN ADMIN_PKG_DIR="$(cd admin && bun -e 'const { dirname } = require("node:path"); const { realpathSync } = require("node:fs"); console.log(dirname(realpathSync(require.resolve("@app-vitals/agent-admin/package.json"))))')" \
    && cp version.txt "$ADMIN_PKG_DIR/../version.txt"

# The generated Prisma client ships inside @app-vitals/agent-admin
# (prisma/client), built at the package's release, so the image does not run
# `prisma generate`: from the installed package its generator resolves the
# package's tsconfig.json, which extends a monorepo-root ../tsconfig.json that
# does not exist under node_modules ("File '../tsconfig.json' not found").
# Fail the build if the shipped client is missing instead.
RUN cd admin && bun -e 'import.meta.resolve("@app-vitals/agent-admin/prisma/client/client.ts")'

EXPOSE 3000

# Run as a non-root user. The GKE deployment sets `runAsNonRoot: true`, and the
# kubelet can only verify that when the image's USER is a numeric UID (it does
# not read the image's /etc/passwd). uid 1000 is the `bun` user baked into the
# oven/bun base image. Without this the container is refused at admission with
# "container has runAsNonRoot and image will run as root".
USER 1000

ENTRYPOINT ["bun", "run", "admin/src/main.ts"]
