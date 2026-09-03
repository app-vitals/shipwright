# Shipwright Agent — container image
#
# Environment variables:
#   AGENT_HOME              — persistent storage root (default: /data/agent-home)
#                             Mount a PVC here so mise tool caches, workspace files,
#                             and the ~/.claude symlink target all survive restarts.
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

# ─── Node.js binary source ─────────────────────────────────────────────────
# Copied into the base stage below instead of piping deb.nodesource.com's
# setup script through bash — that endpoint intermittently 403s in CI,
# blocking every build. node:22-trixie-slim matches oven/bun:1-slim's Debian
# release (trixie) so the copied binary is glibc-compatible.
FROM node:22-trixie-slim AS node-source

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
#     (Piper TTS for voice-out is bundled in the runtime stage below; ffmpeg /
#     python-edge-tts stay omitted — Piper emits WAV natively.)
#   - Chromium/chromium-headless-shell OS deps for Playwright (PW-1.1/PW-1.2 —
#     agent/src/browser.ts, follow-up task) — installed here as root so the
#     runtime stage's `playwright install chromium-headless-shell` (run as USER
#     1000, no --with-deps) has everything the binary needs to actually launch.
#     This exact package list is Playwright 1.61.1's real dependency set —
#     verified by running `playwright install-deps --dry-run chromium-headless-shell`
#     against an installed 1.61.1, not assumed from docs or an older version's
#     source. That dry run confirms chromium-headless-shell needs the identical
#     package set as full `chromium` on this OS.
#     oven/bun:1-slim is Debian trixie (13) — see node-source stage comment above
#     — hence the t64-suffixed package names (Debian's 64-bit time_t transition).
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    unzip \
    jq \
    build-essential \
    libssl-dev \
    pkg-config \
    fonts-freefont-ttf \
    fonts-ipafont-gothic \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-tlwg-loma-otf \
    fonts-unifont \
    fonts-wqy-zenhei \
    libasound2t64 \
    libatk-bridge2.0-0t64 \
    libatk1.0-0t64 \
    libatspi2.0-0t64 \
    libcairo2 \
    libcups2t64 \
    libdbus-1-3 \
    libdrm2 \
    libfontconfig1 \
    libfreetype6 \
    libgbm1 \
    libglib2.0-0t64 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xfonts-scalable \
    xvfb \
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
# Node itself is copied from the node-source stage above rather than fetched via
# deb.nodesource.com (see that stage's comment).
COPY --from=node-source /usr/local/bin/node /usr/local/bin/node
COPY --from=node-source /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && npm install -g @anthropic-ai/claude-code@2.1.236

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
COPY mcp-server/package.json ./mcp-server/
COPY patches/ ./patches/

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
# playwright/playwright-core are externalized: bun's bundler eagerly resolves
# playwright-core's internal optional chromium-bidi requires, which aren't
# actually installed or used by our CDP-based launch path.
RUN find agent/src -name "*.ts" | xargs bun build --target=bun --external playwright --external playwright-core --outdir=/tmp/module-check

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

# ─── Playwright chromium-headless-shell (agent/src/browser.ts, PW-1.2) ────────
# Installed as the already-active USER 1000, under /home/bun — mirrors mise's
# non-root-first pattern above rather than Piper's root-then-chown below, so no
# chown step is needed and nothing lands root-owned. PLAYWRIGHT_BROWSERS_PATH is
# an ENV (not just a build-time var), so it stays set for the running container
# too — Playwright's launch API resolves the browser path from this same var.
# `playwright` is pinned to 1.61.1 in agent/package.json: site's @playwright/test
# is ^1.61.1 and metrics' is ^1.49.0 — these diverge, but bun's resolver already
# hoists metrics' range up to 1.61.1 (the newest version satisfying both ranges),
# so 1.61.1 is the version already present in this repo's bun.lock; the agent's
# own `playwright` runtime dep is pinned to match rather than introducing a third
# version. No --with-deps here (that would `apt-get install` as non-root and
# fail) — the OS-level deps were already installed as root in the base stage.
ENV PLAYWRIGHT_BROWSERS_PATH=/home/bun/.cache/ms-playwright
RUN ./agent/node_modules/.bin/playwright install chromium-headless-shell

# ─── Piper offline TTS (voice-out) ────────────────────────────────────────────
# Bundle the Piper binary + the default voice so the agent can synthesize voice
# replies with no external TTS key. When voice is enabled (agent.voice.enabled) and
# no ElevenLabs key is set, synthesizeSpeech() (agent/src/voice.ts) falls back to
# spawning a bare `piper` on PATH. piper-voice.ts hardcodes the model dir to
# /app/agent/voices/ and the default voice en_US-hfc_female-medium, so the model
# MUST live at that exact path. The release tarball is self-contained — its shared
# libs + espeak-ng-data sit beside the binary with an $ORIGIN rpath — so putting
# /opt/piper on PATH is all that's needed (no ffmpeg: Piper writes WAV directly, and
# Slack's files.uploadV2 accepts WAV). curl + tar come from the base stage.
# Installed as root (the runtime user is uid 1000); the voice dir is chowned back so
# the non-root user can read it. This runs AFTER the /app/agent COPY above so the
# voices aren't clobbered by that layer. amd64 only — the harness image is built
# single-arch; an arm64 build would need the aarch64 asset.
USER root
ARG PIPER_VERSION=2023.11.14-2
RUN curl -fsSL -o /tmp/piper.tar.gz \
      "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz" \
    && tar -xzf /tmp/piper.tar.gz -C /opt \
    && rm /tmp/piper.tar.gz \
    && mkdir -p /app/agent/voices \
    && curl -fsSL -o /app/agent/voices/en_US-hfc_female-medium.onnx \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx" \
    && curl -fsSL -o /app/agent/voices/en_US-hfc_female-medium.onnx.json \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx.json" \
    && chown -R 1000:1000 /app/agent/voices
ENV PATH="/opt/piper:${PATH}"
USER 1000

VOLUME ["/data/agent-home"]

# Expose the health probe port (always active)
EXPOSE 3459

# Entrypoint: run the startup sequence then hand off to the agent server
ENTRYPOINT ["bun", "run", "/app/agent/src/entrypoint-main.ts"]
