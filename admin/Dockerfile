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
COPY agent/package.json ./agent/
COPY metrics/package.json ./metrics/
COPY plugins/shipwright/package.json ./plugins/shipwright/
COPY lib/package.json ./lib/

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
# NOT the hoisted root — both are required at runtime.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/admin/node_modules ./admin/node_modules

# Copy entire monorepo source
COPY . .

# Generate Prisma client
RUN cd admin && bunx prisma generate --schema=prisma/schema.prisma

EXPOSE 3000

# Run as a non-root user. The GKE deployment sets `runAsNonRoot: true`, and the
# kubelet can only verify that when the image's USER is a numeric UID (it does
# not read the image's /etc/passwd). uid 1000 is the `bun` user baked into the
# oven/bun base image. Without this the container is refused at admission with
# "container has runAsNonRoot and image will run as root".
USER 1000

ENTRYPOINT ["bun", "run", "admin/src/main.ts"]
