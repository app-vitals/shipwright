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
COPY admin/prisma ./admin/prisma/
COPY task-store/package.json ./task-store/
COPY task-store/prisma ./task-store/prisma/
COPY chat/package.json ./chat/
COPY chat/prisma ./chat/prisma/
COPY agent/package.json ./agent/
COPY metrics/package.json ./metrics/
COPY plugins/shipwright/package.json ./plugins/shipwright/
COPY lib/package.json ./lib/
COPY mcp-server/package.json ./mcp-server/

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
# NOT the hoisted root — both are required at runtime. lib/node_modules is also
# copied defensively: bun nests a shared lib dependency under lib/node_modules
# instead of hoisting it to root whenever a consuming service also declares that
# same dependency directly (this broke task-store + @sentry/bun at runtime —
# see app-vitals/shipwright#1187). mcp-server doesn't hit that today, but copying
# lib/node_modules here means it can't happen silently if that changes.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/mcp-server/node_modules ./mcp-server/node_modules
COPY --from=deps /app/lib/node_modules ./lib/node_modules

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
