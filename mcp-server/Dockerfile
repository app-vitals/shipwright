# Shipwright MCP Server — container image
#
# Build from repo root:
#   docker build -f mcp-server/Dockerfile -t shipwright-mcp-server .
#
# Run:
#   docker run \
#     -p 3010:3010 \
#     shipwright-mcp-server
#
# Optional env vars:
#   PORT — listen port (default: 3010)

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

# Install system dependencies (ca-certificates only — stateless service, no toolchain needed)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

# Copy hoisted + workspace-local node_modules from the deps stage. bun workspaces
# install package-specific deps under the workspace dir (/app/mcp-server/node_modules),
# NOT the hoisted root — both are required at runtime. The root node_modules also
# carries bun's package store (node_modules/.bun), which is where the registry
# package @app-vitals/agent-lib (and its own deps, e.g. @sentry/bun) lives; the
# workspace-local @app-vitals/agent-lib entries are symlinks into it.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/mcp-server/node_modules ./mcp-server/node_modules

# Copy entire monorepo source
COPY . .

EXPOSE 3010

# Run as a non-root user. The GKE deployment sets `runAsNonRoot: true`, and the
# kubelet can only verify that when the image's USER is a numeric UID (it does
# not read the image's /etc/passwd). uid 1000 is the `bun` user baked into the
# oven/bun base image. Without this the container is refused at admission with
# "container has runAsNonRoot and image will run as root".
USER 1000

ENTRYPOINT ["bun", "run", "mcp-server/src/main.ts"]
