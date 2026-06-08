# Shipwright Agent — container image
#
# Build:
#   docker build -t shipwright-agent .
#
# Run:
#   docker run \
#     -e SHIPWRIGHT_API_URL=https://... \
#     -e SHIPWRIGHT_INTERNAL_API_KEY=... \
#     -e SHIPWRIGHT_AGENT_ID=... \
#     -v /host/agent-home:/data/agent-home \
#     shipwright-agent
#
# AGENT_HOME (/data/agent-home) should be a persistent volume:
#   - ~/.claude is symlinked here (dot-claude/)
#   - workspace/, sessions.json, mise data, and token files persist across restarts
#
# PVC mount point: /data/agent-home
#   dot-claude/   → symlinked to ~/.claude
#   claude.json   → symlinked to ~/.claude.json
#   workspace/    → agent workspace (workspace code, state, repos)
#   mise/         → mise data dir (tool installs cached here)

# ─── Stage 1: dependencies ────────────────────────────────────────────────────
FROM oven/bun:1-slim AS deps

WORKDIR /app

# Copy workspace manifests for dependency install
COPY package.json bun.lock ./
COPY agent/package.json ./agent/
COPY metrics/package.json ./metrics/
COPY plugins/shipwright/package.json ./plugins/shipwright/

RUN bun install --frozen-lockfile

# ─── Stage 2: production image ────────────────────────────────────────────────
FROM oven/bun:1-slim AS production

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    nodejs \
    npm \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code globally via npm
RUN npm install -g @anthropic-ai/claude-code

# Install gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install mise
RUN curl https://mise.run | sh && ln -s /root/.local/bin/mise /usr/local/bin/mise

WORKDIR /app

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/agent/node_modules ./agent/node_modules 2>/dev/null || true

# Copy entire monorepo
COPY . .

# Generate Prisma client
RUN cd agent && bunx prisma generate --schema=prisma/schema.prisma

# Agent home — persistent volume mount point
ENV AGENT_HOME=/data/agent-home
VOLUME ["/data/agent-home"]

ENTRYPOINT ["bun", "run", "agent/scripts/entrypoint.ts"]
