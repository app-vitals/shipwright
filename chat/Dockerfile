# Shipwright Chat Service — container image
#
# Build from repo root:
#   docker build -f chat/Dockerfile -t shipwright-chat .
#
# Run:
#   docker run \
#     -e DATABASE_URL_SHIPWRIGHT_CHAT=postgres://... \
#     -p 3000:3000 \
#     shipwright-chat

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

# Install system dependencies (ca-certificates only — no Claude Code, no gh CLI, no mise)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

# Copy hoisted + workspace-local node_modules from the deps stage. bun workspaces
# install package-specific deps under the workspace dir (/app/chat/node_modules),
# NOT the hoisted root — both are required at runtime. lib/node_modules is also
# copied defensively: bun nests a shared lib dependency under lib/node_modules
# instead of hoisting it to root whenever a consuming service also declares that
# same dependency directly (this broke task-store + @sentry/bun at runtime —
# see app-vitals/shipwright#1187). chat doesn't hit that today, but copying
# lib/node_modules here means it can't happen silently if that changes.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/chat/node_modules ./chat/node_modules
COPY --from=deps /app/lib/node_modules ./lib/node_modules

# Copy entire monorepo source
COPY . .

# Generate Prisma client
RUN cd chat && bunx prisma generate --schema=prisma/schema.prisma

EXPOSE 3000

# Run as a non-root user. The GKE deployment sets `runAsNonRoot: true`, and the
# kubelet can only verify that when the image's USER is a numeric UID (it does
# not read the image's /etc/passwd). uid 1000 is the `bun` user baked into the
# oven/bun base image. Without this the container is refused at admission with
# "container has runAsNonRoot and image will run as root".
USER 1000

ENTRYPOINT ["bun", "run", "chat/src/main.ts"]
