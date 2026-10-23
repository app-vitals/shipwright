# Agent runtime — container image (ghcr.io/app-vitals/agent)
#
# Build from the repository root:  docker build -f runtime/Dockerfile .
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
FROM node:24-trixie-slim AS node-source

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
#     agent/src/runtime/browser.ts, follow-up task) — installed here as root so the
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
# non-root runtime user can invoke it). Downloaded to a file first (rather than
# piped straight into sh) so curl's own exit code gates the step — dash (this
# base image's /bin/sh) has no pipefail, so `curl ... | sh` on a transient
# curl failure (e.g. a mid-download connection reset) sends sh 0 bytes on
# stdin, which sh happily runs as a no-op and exits 0, silently shipping an
# image with no /usr/local/bin/mise. The trailing `test -x` is a second,
# independent gate against the installer itself running but not landing the
# binary at this exact path.
RUN curl -fsSL -o /tmp/mise-install.sh https://mise.run \
    && MISE_INSTALL_PATH=/usr/local/bin/mise sh /tmp/mise-install.sh \
    && rm /tmp/mise-install.sh \
    && test -x /usr/local/bin/mise

# Install Node.js + Claude Code CLI system-wide (as root) on /usr/bin.
# claude is a plain binary on PATH (/usr/bin/claude) backed by system node — it is
# NOT a mise shim, so its resolution never depends on the active mise/workspace
# context (which is what broke the previous mise-reshim approach: "claude is not a
# valid shim"). mise stays purely a runtime *workspace* tool-version manager.
# Node itself is copied from the node-source stage above rather than fetched via
# deb.nodesource.com (see that stage's comment).
COPY --from=node-source /usr/local/bin/node /usr/local/bin/node
COPY --from=node-source /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
# renovate: datasource=npm depName=@anthropic-ai/claude-code
ARG CLAUDE_CODE_VERSION=2.1.292
# The trailing check fails the build if the installed CLI doesn't report exactly
# the pinned version (e.g. a registry/tag mismatch), so a drifted image can't ship.
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && INSTALLED="$(claude --version)" \
    && echo "claude --version: ${INSTALLED}" \
    && case "${INSTALLED}" in \
         "${CLAUDE_CODE_VERSION} "*) ;; \
         *) echo "claude --version reported '${INSTALLED}', expected ${CLAUDE_CODE_VERSION}" >&2; exit 1 ;; \
       esac

# Anthropic's container guidance for reproducible builds: pin the version above
# and disable the in-container auto-updater. Self-update can't work here anyway
# (root-owned npm global dir, uid 1000 runtime, ephemeral pods). Set in the base
# stage so it carries into runtime; runtime/claude.ts builds the child env
# from process.env, so spawned claude processes inherit it.
ENV DISABLE_AUTOUPDATER=1

# ─── Build stage ──────────────────────────────────────────────────────────────

FROM base AS build

WORKDIR /app

# Workspace manifests first (layer caching for deps). admin/prisma is needed
# because admin's postinstall runs `prisma generate`. bun.lock is copied when
# the repository has one.
COPY package.json bunfig.toml bun.lock* ./
COPY runtime/package.json ./runtime/
COPY admin/package.json ./admin/
COPY admin/prisma ./admin/prisma/
COPY admin/prisma.config.ts ./admin/
COPY lib/package.json ./lib/
COPY patches/ ./patches/

RUN if [ -f bun.lock ]; then bun install --frozen-lockfile; else bun install; fi

# Workspace sources. @app-vitals/agent-lib / -runtime / -admin are workspace
# symlinks; only their package.json files were copied above, so the sources
# must exist for the symlinks to resolve.
COPY runtime/ ./runtime/
COPY admin/ ./admin/
COPY lib/ ./lib/
# Agent-type definitions (setup.ts reads identity.templatesDir from them).
COPY agent-types/ ./agent-types/
# Composition root spawned by runtime/entrypoint.ts (../index.ts).
COPY index.ts ./index.ts
COPY scripts/ ./scripts/

# Module-resolution guard: bundle every runtime source file as its own entry
# point so an unresolvable import fails the build itself, rather than only
# surfacing as a runtime crash after the image ships. A plain `docker build`
# succeeding is not proof the image runs; this bundles the whole runtime tree,
# not just entrypoint-main.ts's reachable graph.
# playwright/playwright-core are externalized: bun's bundler eagerly resolves
# playwright-core's internal optional chromium-bidi requires, which aren't
# actually installed or used by our CDP-based launch path.
RUN find runtime -name "*.ts" | xargs bun build --target=bun --external playwright --external playwright-core --outdir=/tmp/module-check

# ─── Runtime stage (non-root) ─────────────────────────────────────────────────

FROM base AS runtime

WORKDIR /app

ENV NODE_ENV=production

# AGENT_HOME: mount a persistent volume here.
ENV AGENT_HOME=/data/agent-home

# Create the persistent-volume mount point and hand it to uid 1000 so the agent
# can write when no volume is mounted. A mounted PVC needs `fsGroup: 1000`.
RUN mkdir -p /data/agent-home && chown 1000:1000 /data/agent-home

USER 1000
ENV HOME=/home/bun

# mise workspace tool shims first on PATH; /app/scripts/bin holds the
# git-credential helper (runtime/entrypoint-main.ts resolves it relative to
# the repository root).
ENV PATH="/home/bun/.local/share/mise/shims:/app/scripts/bin:${PATH}"

COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/runtime ./runtime
COPY --from=build --chown=1000:1000 /app/admin ./admin
COPY --from=build --chown=1000:1000 /app/lib ./lib
COPY --from=build --chown=1000:1000 /app/agent-types ./agent-types
COPY --from=build --chown=1000:1000 /app/index.ts ./index.ts
COPY --from=build --chown=1000:1000 /app/scripts ./scripts
COPY --from=build --chown=1000:1000 /app/package.json ./package.json

RUN chmod +x /app/scripts/bin/git-credential-shipwright.sh

# ─── Playwright chromium-headless-shell (runtime/browser.ts) ──────────────────
# Installed as the already-active USER 1000 under /home/bun, so nothing lands
# root-owned. No --with-deps: the OS-level deps were installed as root in the
# base stage.
ENV PLAYWRIGHT_BROWSERS_PATH=/home/bun/.cache/ms-playwright
RUN bunx playwright install chromium-headless-shell

# ─── Piper offline TTS (voice-out) ────────────────────────────────────────────
# runtime/piper-voice.ts hardcodes the model dir to /app/agent/voices/, so the
# model MUST live at that exact path. amd64 only.
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

# Health probe port
EXPOSE 3459

# Base-image contract (downstream images build FROM this one):
#   - marketplaces COPYed to /opt/shipwright/marketplaces/<name>/ are registered
#     at boot by installPlugins() (runtime/setup.ts)
#   - the entrypoint path below is stable
ENTRYPOINT ["bun", "run", "/app/runtime/entrypoint-main.ts"]
