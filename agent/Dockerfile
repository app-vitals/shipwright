# Shipwright Agent — container image
#
# Environment variables:
#   AGENT_HOME              — persistent storage root (default: /data/agent-home)
#                             Mount a PVC here so mise tool caches, workspace files,
#                             and the ~/.claude symlink target all survive restarts.
#   PORT                    — dev-only chat server port (default: 3000, DEFAULT-DENY)
#                             Only used when SHIPWRIGHT_DEV_CHAT=true. Not used in production.
#   SHIPWRIGHT_HEALTH_PORT  — K8s liveness probe port (default: 3459)
#
# PVC mount point:
#   /data/agent-home — mount a PersistentVolumeClaim (or any durable volume) here.
#                    The agent symlinks ~/.claude → $AGENT_HOME/dot-claude so
#                    Claude Code settings and memory persist across pod restarts.
#                    The container runs as uid 1000, so the pod must set
#                    `securityContext.fsGroup: 1000` for the mounted volume to be
#                    writable.
#
# Required env vars at runtime:
#   SHIPWRIGHT_AGENT_ID            — the agent's ID in the Shipwright platform
#   SHIPWRIGHT_API_URL             — base URL of the Shipwright API
#   SHIPWRIGHT_AGENT_API_KEY       — bearer token for the config endpoint
#   ANTHROPIC_API_KEY              — Anthropic API key (or CLAUDE_CODE_OAUTH_TOKEN)

# ─── Base: system tooling installed as root ───────────────────────────────────

FROM oven/bun:1-slim AS base

# Install system dependencies:
#   - git          — required by Claude Code and mise
#   - curl         — used by the mise installer and gh keyring setup
#   - ca-certificates — TLS trust for API calls
#   - unzip        — needed by some mise-managed tools
#   - jq           — bash JSON parsing in the time-tracking Claude Code hooks
#   - build-essential / libssl-dev / pkg-config — native + Rust toolchain so the
#     agent can build client code at runtime (e.g. Rust projects + OpenSSL crates).
#     (voice deps — python/edge-tts/ffmpeg — deliberately omitted; voice is not
#     deployed on the Shipwright harness yet.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    unzip \
    jq \
    build-essential \
    libssl-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Install gh CLI via official GitHub apt keyring
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Install the mise binary to a world-executable location (NOT /root, so the
# non-root runtime user can invoke it).
RUN curl https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh

# Install Node.js + Claude Code CLI system-wide (as root) on /usr/bin.
# claude is a plain binary on PATH (/usr/bin/claude) backed by system node — it is
# NOT a mise shim, so its resolution never depends on the active mise/workspace
# context (which is what broke the previous mise-reshim approach: "claude is not a
# valid shim"). mise stays purely a runtime *workspace* tool-version manager.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @anthropic-ai/claude-code@2.1.170 \
    && rm -rf /var/lib/apt/lists/*

# ─── Build stage ──────────────────────────────────────────────────────────────

FROM base AS build

# Bare semver (no "agent-v" prefix) for the tag this image is being built
# for — passed via --build-arg from build-agent.yml. Stamped into the
# plugin's version files below so the deployed image always matches the tag
# it was built for, independent of scripts/sync-version.ts's separate,
# asynchronous git-commit path (.github/workflows/sync-plugin-version.yml).
# Defaulted so ci.yml's PR-time `docker build` (no --build-arg passed) still
# succeeds — sync-version.ts requires valid semver and would fail on empty.
ARG AGENT_VERSION=0.0.0-dev

WORKDIR /app

# Copy workspace manifests first (layer caching for deps)
COPY package.json bunfig.toml* bun.lock ./
COPY agent/package.json ./agent/
COPY metrics/package.json ./metrics/
COPY admin/package.json ./admin/
COPY admin/prisma ./admin/prisma/
COPY task-store/package.json ./task-store/
COPY task-store/prisma ./task-store/prisma/
COPY chat/package.json ./chat/
COPY chat/prisma ./chat/prisma/
COPY plugins/shipwright/package.json ./plugins/shipwright/
COPY lib/package.json ./lib/

# Install all dependencies (including devDependencies for typecheck)
RUN bun install --frozen-lockfile

# Copy the rest of the agent source
COPY agent/ ./agent/
# Copy the shared lib source — @shipwright/lib is a workspace symlink; only its
# package.json was copied above (for install caching), so without this the
# symlink resolves but re-exports like @shipwright/lib/pricing are missing.
COPY lib/ ./lib/
# Copy the plugin source so the local marketplace is available at runtime
COPY plugins/ ./plugins/
COPY .claude-plugin/ ./.claude-plugin/
# Copy the version-sync script so the version stamp below can run.
COPY scripts/ ./scripts/

# Stamp AGENT_VERSION into the plugin's version files inside the image only
# (no git commit, no git operations) — see ARG AGENT_VERSION above for why.
RUN bun run scripts/sync-version.ts "${AGENT_VERSION}"

# Module-resolution guard: bundle every agent source file as its own entry
# point so an unresolvable import fails the build itself, rather than only
# surfacing as a runtime crash after the image ships. A plain `docker build`
# succeeding is not proof the image runs — this bundles the whole agent/src
# tree (not just entrypoint-main.ts's reachable graph) so an import missed
# by that one entry point, like the lib/ omission above, still gets caught.
RUN find agent/src -name "*.ts" | xargs bun build --target=bun --outdir=/tmp/module-check

# ─── Runtime stage (non-root) ─────────────────────────────────────────────────

FROM base AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Set AGENT_HOME — the PVC should be mounted here in Kubernetes
ENV AGENT_HOME=/data/agent-home

# Create the persistent-volume mount point and hand it to uid 1000 so the agent
# can write when no PVC is mounted. A mounted PVC needs `fsGroup: 1000` in the
# pod securityContext to be writable.
RUN mkdir -p /data/agent-home && chown 1000:1000 /data/agent-home

# Switch to the non-root `bun` user (uid 1000, baked into the oven/bun base) for
# all tool installs below, so mise, node, and Claude Code land under /home/bun
# (owned by uid 1000) and are usable at runtime. The GKE deployment sets
# `runAsNonRoot: true`, which the kubelet can only verify against a numeric UID.
USER 1000
ENV HOME=/home/bun

# mise runtime *workspace* tool shims live under the user's data dir, first on
# PATH. node + claude are system-wide (installed in the base stage) and resolve
# via the inherited /usr/bin — they are intentionally NOT mise shims.
# /app/agent/scripts/bin holds the git-credential-shipwright.sh and gh wrappers.
ENV PATH="/home/bun/.local/share/mise/shims:/app/agent/scripts/bin:${PATH}"

# Copy installed node_modules + agent source from the build stage, owned by the
# runtime user. (The agent dir carries its own workspace node_modules symlinks;
# the root node_modules holds bun's content-addressed store they point into.)
COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/agent ./agent
# agent/node_modules/@shipwright/lib is a relative symlink to /app/lib — the
# workspace source itself, not just its package.json, must exist here too.
COPY --from=build --chown=1000:1000 /app/lib ./lib
# Plugin source + marketplace manifest — needed for local `claude plugin marketplace add`
COPY --from=build --chown=1000:1000 /app/plugins ./plugins
COPY --from=build --chown=1000:1000 /app/.claude-plugin ./.claude-plugin

# Make the credential helper and gh wrapper executable
RUN chmod +x /app/agent/scripts/bin/git-credential-shipwright.sh \
    && chmod +x /app/agent/scripts/bin/gh

VOLUME ["/data/agent-home"]

# Expose the health probe port (always active) and the dev-only chat port
EXPOSE 3459
EXPOSE 3000

# Entrypoint: run the startup sequence then hand off to the agent server
ENTRYPOINT ["bun", "run", "/app/agent/src/entrypoint-main.ts"]
