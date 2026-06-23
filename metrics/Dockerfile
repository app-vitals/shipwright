# Shipwright Metrics Dashboard — container image
#
# Build from repo root:
#   docker build -f metrics/Dockerfile -t shipwright-metrics .
#
# Run (PostHog mode):
#   docker run \
#     -e POSTHOG_PERSONAL_API_KEY=phx_... \
#     -e POSTHOG_PROJECT_ID=<project-id> \
#     -e SHIPWRIGHT_SESSION_SECRET=... \
#     -p 3460:3460 \
#     shipwright-metrics
#
# Optional env vars:
#   METRICS_API_PORT           — listen port (default: 3460)
#   METRICS_API_KEYS           — Bearer API keys for /metrics/* endpoints
#   METRICS_REQUIRE_OWNER_ROLE — gate dashboard on OWNER role (default: false)
#   METRICS_ADMIN_URL          — shipwright admin service base URL (default: http://localhost:3000)
#   METRICS_INTERNAL_API_KEY   — internal key for accounts client
#   SHIPWRIGHT_ENV_FILE        — dotenv file loaded at startup (default: ~/.shipwright/.env)

# ─── Stage 1: dependencies ────────────────────────────────────────────────────
FROM oven/bun:1-slim AS deps

WORKDIR /app

# Copy workspace manifests for dependency install
COPY package.json bun.lock ./
COPY metrics/package.json ./metrics/
COPY admin/package.json ./admin/
COPY admin/prisma ./admin/prisma/
COPY task-store/package.json ./task-store/
COPY task-store/prisma ./task-store/prisma/
COPY agent/package.json ./agent/
COPY plugins/shipwright/package.json ./plugins/shipwright/
COPY lib/package.json ./lib/

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
# install package-specific deps under the workspace dir (/app/metrics/node_modules),
# NOT the hoisted root — both are required at runtime.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/metrics/node_modules ./metrics/node_modules

# Copy entire monorepo source
COPY . .

EXPOSE 3460

# Run as a non-root user. The GKE deployment sets `runAsNonRoot: true`, and the
# kubelet can only verify that when the image's USER is a numeric UID. uid 1000
# is the `bun` user baked into the oven/bun base image.
USER 1000

ENTRYPOINT ["bun", "run", "metrics/src/server.ts"]
