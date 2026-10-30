# Shipwright Agent — container image (AGR-4.3b)
#
# Builds the Shipwright coding agent FROM the published platform runtime image
# (ghcr.io/app-vitals/agent) and layers only what is Shipwright's: the coding
# extension, the plugins, the marketplace manifest and the coding workspace
# templates. System
# tooling, Node + Claude Code, Playwright chromium, Piper and the runtime/admin
# sources all come from the platform image (the Claude Code pin and its Renovate
# bump live there now).
#
# build-agent.yml builds and tags this file as ghcr.io/app-vitals/shipwright-agent
# (agent-vX.Y.Z); the specialists image derives FROM it. ci.yml builds it as
# shipwright-agent:ci and runs the contract checks against it.
#
# The platform image keeps the runtime at /app/runtime and its entrypoint at
# /app/runtime/entrypoint-main.ts (which spawns /app/index.ts), so the coding
# composition root is wired in by replacing /app/index.ts rather than by owning
# the entrypoint.
#
# Build from the repository root:
#   docker build -f agent/Dockerfile -t shipwright-agent:ci .

# Platform release to build on. Keep equal to the @app-vitals/agent-lib pin in
# agent/package.json (guarded by agent-platform-image.content.test.ts): the
# coding extension is compiled against that package set.
ARG PLATFORM_VERSION=0.16.0

# ─── Version stamp stage ──────────────────────────────────────────────────────
# Stamps AGENT_VERSION into the plugin version files inside the image only (no
# git commit), same as agent/Dockerfile's build stage. Defaulted so a PR-time
# `docker build` without --build-arg still succeeds: sync-version.ts requires
# valid semver.
FROM oven/bun:1-slim AS stamp
ARG AGENT_VERSION=0.0.0-dev
WORKDIR /app
COPY package.json version.txt ./
COPY metrics/package.json ./metrics/
COPY agent/package.json ./agent/
COPY plugins/ ./plugins/
COPY .claude-plugin/ ./.claude-plugin/
COPY scripts/sync-version.ts ./scripts/sync-version.ts
RUN bun run scripts/sync-version.ts "${AGENT_VERSION}"

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM ghcr.io/app-vitals/agent:${PLATFORM_VERSION} AS runtime

USER root
WORKDIR /app

# Coding extension + the scripts CI runs against the image (verify-*.ts) and the
# lib resolution guard.
COPY --chown=1000:1000 agent/src/coding ./agent/src/coding
COPY --chown=1000:1000 agent/src/index.ts ./agent/src/index.ts
COPY --chown=1000:1000 agent/scripts ./agent/scripts
# Plugin source + marketplace manifest, version-stamped. The coding extension
# imports plugins/shipwright/scripts/* by relative path from agent/src/coding.
COPY --from=stamp --chown=1000:1000 /app/plugins ./plugins
COPY --from=stamp --chown=1000:1000 /app/.claude-plugin ./.claude-plugin
# Coding-owned workspace templates. The platform owns the rest of
# /app/runtime/workspace; copy only these two so its own templates stay intact.
COPY --chown=1000:1000 agent/workspace/CLAUDE.md.template ./runtime/workspace/CLAUDE.md.template
COPY --chown=1000:1000 agent/workspace/CLAUDE-HITL.md.template ./runtime/workspace/CLAUDE-HITL.md.template
# The full coding template set, at agent/workspace/ relative to
# SHIPWRIGHT_REPO_ROOT (the coding specialty's templates dir; the coding
# specialty itself is code defaults in admin/src/coding, not a manifest).
COPY --chown=1000:1000 agent/workspace ./agent/workspace

# The runtime derives its repo root from its own module path, which resolves to
# `/` in this layout. Point it at the root that holds plugins/ and .claude-plugin/.
ENV SHIPWRIGHT_REPO_ROOT=/app

# The gh owner-routing wrapper and git credential helper come from the platform
# image (/app/scripts/bin is already on PATH there), so nothing is overridden here.

# js-yaml is only an override in the platform's package.json, not a dependency, so
# it is not resolvable from /app. The plugin scripts (suppressions.ts,
# resolve-dependency-watched-paths.ts) import it. Install it in a scratch dir and
# copy it (with its own deps) into /app/node_modules without clobbering anything
# the platform already ships.
RUN mkdir /tmp/js-yaml-install && cd /tmp/js-yaml-install \
    && bun add js-yaml@^5.0.0 \
    && cp -rn node_modules/. /app/node_modules/ \
    && chown -R 1000:1000 /app/node_modules/js-yaml \
    && rm -rf /tmp/js-yaml-install

# The platform entrypoint spawns /app/index.ts; point it at the coding
# composition root.
RUN printf 'import "./agent/src/index.ts";\n' > /app/index.ts \
    && chown 1000:1000 /app/index.ts

USER 1000

# Module-resolution guards on the filesystem that ships: every coding source file
# must bundle (catches an import the platform image does not provide), and every
# @app-vitals/agent-lib specifier must resolve from where it is imported.
RUN find agent/src -name "*.ts" ! -name "*.test.ts" \
      | xargs bun build --target=bun --external playwright --external playwright-core --outdir=/tmp/module-check \
    && rm -rf /tmp/module-check \
    && bun /app/agent/scripts/check-lib-resolution.ts --require @app-vitals/agent-lib /app/agent/src
