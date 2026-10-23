# Admin service image (ghcr.io/app-vitals/agent-admin)
#
# Build from the repository root:  docker build -f admin/Dockerfile .

FROM oven/bun:1-slim AS deps

WORKDIR /app

COPY package.json bunfig.toml bun.lock* ./
COPY admin/package.json ./admin/
COPY admin/prisma ./admin/prisma/
COPY admin/prisma.config.ts ./admin/
COPY runtime/package.json ./runtime/
COPY lib/package.json ./lib/
COPY patches/ ./patches/

RUN if [ -f bun.lock ]; then bun install --frozen-lockfile; else bun install; fi

FROM oven/bun:1-slim AS production

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/admin/node_modules ./admin/node_modules
COPY --from=deps /app/lib/node_modules ./lib/node_modules

# .dockerignore keeps node_modules, .git and build output out of the context.
COPY . .

# The generated Prisma client is not committed.
RUN cd admin && bunx prisma generate --schema=prisma/schema

EXPOSE 3000

USER 1000

ENTRYPOINT ["bun", "run", "admin/src/main.ts"]
