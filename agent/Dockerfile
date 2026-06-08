# Shipwright Agent — container image
#
# Environment variables:
#   AGENT_HOME     — persistent storage root (default: /agent-home)
#                    Mount a PVC here so mise tool caches, workspace files,
#                    and the ~/.claude symlink target all survive restarts.
#   PORT           — Hono server port (default: 3000)
#
# PVC mount point:
#   /agent-home    — mount a PersistentVolumeClaim (or any durable volume) here.
#                    The agent symlinks ~/.claude → $AGENT_HOME/dot-claude so
#                    Claude Code settings and memory persist across pod restarts.
#
# Required env vars at runtime:
#   SHIPWRIGHT_AGENT_ID            — the agent's ID in the Shipwright platform
#   SHIPWRIGHT_API_URL             — base URL of the Shipwright API
#   SHIPWRIGHT_INTERNAL_API_KEY    — bearer token for the config endpoint
#   ANTHROPIC_API_KEY              — Anthropic API key (or CLAUDE_CODE_OAUTH_TOKEN)

FROM oven/bun:1.3 AS base

# Install system dependencies:
#   - git          — required by Claude Code and mise
#   - curl         — used by mise installer
#   - ca-certificates — TLS trust for API calls
#   - unzip        — needed by some mise-managed tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install mise (polyglot runtime manager)
RUN curl https://mise.run | sh && \
    ln -s /root/.local/bin/mise /usr/local/bin/mise

# ─── Build stage ──────────────────────────────────────────────────────────────

FROM base AS build

WORKDIR /app

# Copy workspace manifests first (layer caching for deps)
COPY package.json bunfig.toml* ./
COPY agent/package.json ./agent/
COPY agent/prisma ./agent/prisma/

# Install all dependencies (including devDependencies for typecheck)
RUN bun install --frozen-lockfile

# Copy the rest of the agent source
COPY agent/ ./agent/

# Generate Prisma client
RUN cd agent && bunx prisma generate --schema=prisma/schema.prisma

# ─── Runtime stage ────────────────────────────────────────────────────────────

FROM base AS runtime

WORKDIR /app

# Set AGENT_HOME — the PVC should be mounted here in Kubernetes
ENV AGENT_HOME=/agent-home

# Copy installed node_modules and generated Prisma client from build stage
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/agent ./agent

# Add scripts/bin to PATH so the git-credential-shipwright.sh wrapper
# and gh wrapper are available to subprocesses
ENV PATH="/app/agent/scripts/bin:${PATH}"

# Make credential helper executable
RUN chmod +x /app/agent/scripts/bin/git-credential-shipwright.sh \
    && chmod +x /app/agent/scripts/bin/gh

# Create mount point directory (overridden by PVC in Kubernetes)
RUN mkdir -p /agent-home

# Expose the Hono server port
EXPOSE 3000

# Entrypoint: run the startup sequence then hand off to the agent server
ENTRYPOINT ["bun", "run", "/app/agent/src/entrypoint-main.ts"]
