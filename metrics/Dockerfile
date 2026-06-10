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
#   METRICS_ACCOUNTS_URL       — accounts service base URL (default: http://localhost:3457)
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
COPY agent/package.json ./agent/
COPY plugins/shipwright/package.json ./plugins/shipwright/

RUN bun install --frozen-lockfile

# ─── Stage 2: production image ────────────────────────────────────────────────
FROM oven/bun:1-slim AS production

# Install system dependencies (ca-certificates only — stateless service, no toolchain needed)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy entire monorepo source
COPY . .

EXPOSE 3460

ENTRYPOINT ["bun", "run", "metrics/src/server.ts"]
