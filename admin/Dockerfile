# Shipwright Admin Service — container image
#
# Build from repo root:
#   docker build -f admin/Dockerfile -t shipwright-admin .
#
# Run:
#   docker run \
#     -e DATABASE_URL=postgres://... \
#     -e SHIPWRIGHT_SESSION_SECRET=... \
#     -e GOOGLE_CLIENT_ID=... \
#     -e GOOGLE_CLIENT_SECRET=... \
#     -e ADMIN_ALLOWED_EMAILS=admin@example.com \
#     -e APP_BASE_URL=https://admin.example.com \
#     -e SHIPWRIGHT_INTERNAL_API_KEY=... \
#     -p 3000:3000 \
#     shipwright-admin

# ─── Stage 1: dependencies ────────────────────────────────────────────────────
FROM oven/bun:1-slim AS deps

WORKDIR /app

# Copy workspace manifests for dependency install
COPY package.json bun.lock ./
COPY admin/package.json ./admin/
COPY agent/package.json ./agent/
COPY metrics/package.json ./metrics/
COPY plugins/shipwright/package.json ./plugins/shipwright/

RUN bun install --frozen-lockfile

# ─── Stage 2: production image ────────────────────────────────────────────────
FROM oven/bun:1-slim AS production

# Install system dependencies (ca-certificates only — no Claude Code, no gh CLI, no mise)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy entire monorepo source
COPY . .

# Generate Prisma client
RUN cd admin && bunx prisma generate --schema=prisma/schema.prisma

EXPOSE 3000

ENTRYPOINT ["bun", "run", "agent/src/run-agent.ts"]
