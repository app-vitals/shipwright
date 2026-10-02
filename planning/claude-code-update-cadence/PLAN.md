# Plan: claude-code-update-cadence

## Context

`agent/Dockerfile` pins `@anthropic-ai/claude-code` to an exact version via an inline
`npm install -g @anthropic-ai/claude-code@2.1.236`. CCV-1.1 (#3091) bumped it once by
hand and explicitly deferred a recurring update mechanism to its own plan-session —
this is that session.

Findings (2026-10-02):

- The pin is static: nothing proposes bumps. On the npm `stable` dist-tag we are on
  2.1.236 against 2.1.285 (`latest` is 2.1.287) — ~49 releases behind one month after
  the manual bump.
- Renovate cannot see the pin: its default Dockerfile manager does not parse
  `RUN npm install -g ...`, and `renovate.json` has no custom manager for it.
- In-container self-update cannot work: `claude doctor` on a live agent reports
  "Can't auto-update: npm global folder isn't writable" (global install lives in a
  root-owned `/usr/local/lib/node_modules`, runtime user is uid 1000), and pods are
  ephemeral, so an update would not survive a restart anyway. Auto-updates are
  nonetheless left "enabled" on the `latest` channel, which is misleading noise.
- A merged change under `agent/**` already flows to deploy with no extra wiring:
  `build-agent.yml` builds and tags `agent-vX`, `auto-bump-chart.yml` pins it into the
  chart. The build only checks that `claude` exists on PATH, not which version.
- Nothing reports the running Claude Code version anywhere.

### What Anthropic recommends (docs: "Development containers")

- For reproducible container builds, install from the Dockerfile with
  `npm install -g @anthropic-ai/claude-code@X.Y.Z` and set `DISABLE_AUTOUPDATER=1`.
  This is what this repo already does, minus the env var.
- The Dev Container Feature always installs latest and relies on in-container
  auto-update; their reference Dockerfile uses `ARG CLAUDE_CODE_VERSION=latest`, and the
  docs describe it as "a working example rather than a maintained base image".
- Anthropic documents no mechanism for keeping a *pinned* image current. The update
  story for pinned images is "rebuild with a new version", i.e. ours to automate.
- The npm package ships the same native binary as the standalone installer; the
  native installer's `~/.local/bin` default was already rejected in CCV for this
  image's root-then-uid-1000 layout.

## Decisions (confirmed by Dan, 2026-10-02)

1. **Channel: `stable`** (~1 week behind `latest`, skips releases with major
   regressions).
2. **Merge: review-required**, via the normal review/patch/deploy pipeline — Renovate
   PRs get this for free. `allow_auto_merge` stays off (the bundle gate depends on it).
3. **Cadence: the existing Monday-morning Renovate window** (`before 6am on monday`).
4. **Visibility: include** — scoped to agent `/health` + a startup log line. An admin
   UI display is out of scope: admin has no agent→admin reporting channel today, so
   that needs its own design.
5. **Disable the in-container auto-updater** in the image (`DISABLE_AUTOUPDATER=1`),
   so the running version always equals the pinned, reviewed one.

## Design

**Dockerfile (CCU-1.1).** Move the version to `ARG CLAUDE_CODE_VERSION=2.1.236`
(mirrors Anthropic's reference Dockerfile) with a `# renovate:` annotation comment, and
install via `npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}` followed
by a build-time assertion that `claude --version` reports exactly that version. Add
`ENV DISABLE_AUTOUPDATER=1`. `agent/src/claude.ts` builds the child env from
`process.env`, so the image-level `ENV` reaches every spawned `claude`.

**Renovate (CCU-1.2).** A `customManagers` regex entry matches the annotated ARG line
(npm datasource, depName `@anthropic-ai/claude-code`). A dedicated `packageRules` entry
sets `followTag: "stable"` and its own `groupName`, declared *after* the generic
"routine dependency updates" rule so it is not folded into the weekly grouped PR.
Schedule is inherited from the repo default (Monday window). A content test couples
`renovate.json` to the real Dockerfile so a reformat of the ARG line cannot silently
disable updates.

**Visibility (CCU-1.3).** Read `claude --version` once at agent startup (injected exec,
fail-soft to `"unknown"`), log it, and include `claudeCodeVersion` in the `/health`
JSON. Additive field; the liveness probe only checks status code.

### Alternatives rejected

- **Scheduled GitHub workflow polling `npm view ... dist-tags.stable`:** same outcome
  with more custom code; revisit only if Renovate's `followTag` misbehaves.
- **Unpinned `@stable` at build time:** builds stop being reproducible; a rebuild
  silently changes the runtime.
- **Runtime self-update (writable npm prefix / native installer):** bypasses review,
  does not persist across pods, and re-opens the path issue CCV already ruled out.
- **`DISABLE_UPDATES` instead of `DISABLE_AUTOUPDATER`:** stricter (also blocks
  manual `claude update`) and aimed at vendors distributing their own channel;
  Anthropic's container guidance names `DISABLE_AUTOUPDATER`. Revisit only if manual
  updates inside a pod ever cause drift.

### Risks / complexity flags

- ⚠ `followTag` is not exercised anywhere in this repo today. CCU-1.2 validates the
  config statically (`renovate-config-validator`); the real proof is Renovate's first
  PR (expected: bump to the current `stable`, 2.1.285 at time of writing) appearing on
  the next Monday run. Confirm via the Dependency Dashboard after merge.
- ⚠ Renovate-authored PRs exercise the review/patch pipeline's bot-author paths; expect
  some friction on the first one rather than treating it as a design failure.
- Merging CCU-1.2 before CCU-1.1 would be a silent no-op (the regex would find no
  annotated ARG), hence the dependency edge.

## Tasks

| ID | Title | Layer | Hours | Complexity | Model | HITL |
|---|---|---|---|---|---|---|
| CCU-1.1 | Pin claude-code via Dockerfile ARG, assert version at build, disable in-container auto-updater | CLI | 2 | 2 | haiku | — |
| CCU-1.2 | Add Renovate custom manager + `followTag: stable` rule for the claude-code ARG | Shared | 3 | 3 | sonnet | — |
| CCU-1.3 | Report running Claude Code version in agent `/health` and startup log | API | 3 | 3 | sonnet | — |

### CCU-1.1 — Pin claude-code via Dockerfile ARG, assert version at build, disable in-container auto-updater

**Description:** In `agent/Dockerfile`, replace the inline pinned version with
`ARG CLAUDE_CODE_VERSION=2.1.236` (preceded by a
`# renovate: datasource=npm depName=@anthropic-ai/claude-code` annotation), install via
`npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`, and fail the build if
`claude --version` does not report exactly `${CLAUDE_CODE_VERSION}`. Add
`ENV DISABLE_AUTOUPDATER=1` in the base stage so it carries into runtime.

**Acceptance criteria:**
- The ARG line is a single line of the form `ARG CLAUDE_CODE_VERSION=<semver>` directly
  under the renovate annotation comment; no other occurrence of a literal
  `@anthropic-ai/claude-code@<semver>` remains in the Dockerfile.
- The install `RUN` fails the build when `claude --version` output's version differs
  from `${CLAUDE_CODE_VERSION}`.
- The runtime image has `DISABLE_AUTOUPDATER=1` in its environment, and `claude doctor`
  inside the built image no longer reports auto-updates as enabled.
- Test decision: no new automated test — the Dockerfile has no unit/integration surface
  and the build-time assertion is itself a gate, exercised by `ci.yml`'s existing
  "agent docker build" job on every PR. No existing tests are retired. The built image's
  `claude --version` and `DISABLE_AUTOUPDATER` are called out in the PR description.

**Dependencies:** none
**Branch:** `feat/ccu-1-1-claude-code-version-arg`
**Safe to deploy standalone:** yes (version unchanged at 2.1.236; additive env var)

### CCU-1.2 — Add Renovate custom manager + `followTag: stable` rule for the claude-code ARG

**Description:** In `renovate.json`, add a `customManagers` regex entry matching the
annotated `ARG CLAUDE_CODE_VERSION=` line in `agent/Dockerfile`, and a `packageRules`
entry for `@anthropic-ai/claude-code` with `followTag: "stable"` and its own `groupName`
(declared after the generic routine-updates grouping rule). Keep the inherited Monday
schedule.

**Acceptance criteria:**
- `renovate.json` passes `renovate-config-validator`.
- A new `*.content.test.ts` reads the real `renovate.json` and `agent/Dockerfile`,
  applies the custom manager's `matchStrings` regex to the Dockerfile text, and asserts
  it extracts `depName=@anthropic-ai/claude-code` and a semver `currentValue`.
- The same test asserts the claude-code `packageRules` entry has `followTag: "stable"`,
  a `groupName` distinct from "routine dependency updates", and appears after the
  generic grouping rule in array order.
- No `schedule` override is added on the new rule (Monday window inherited).
- Test decision: layer = content; add the Dockerfile↔renovate.json coupling test above.
  No existing tests are retired.
- Post-merge (PR description note, not a gate): the Renovate Dependency Dashboard lists
  claude-code with a pending update to current `stable`.

**Dependencies:** CCU-1.1
**Branch:** `feat/ccu-1-2-renovate-claude-code-stable`
**Safe to deploy standalone:** yes (additive config; first Renovate PR is the desired outcome)

### CCU-1.3 — Report running Claude Code version in agent `/health` and startup log

**Description:** Add a small helper that runs `claude --version` once at agent startup
via an injected exec, parses the semver, and falls back to `"unknown"` on any failure or
timeout (never blocks or crashes startup). Log it at startup and include
`claudeCodeVersion` in the `/health` JSON served by `startHealthServer` in
`agent/src/health.ts`.

**Acceptance criteria:**
- `GET /health` includes `claudeCodeVersion` (string); existing fields and status-code
  semantics (200 vs 500 on Slack wedge) are unchanged.
- A startup log line records the detected version.
- A failing or hanging `claude --version` yields `"unknown"` without delaying startup
  beyond a bounded timeout.
- Test decision: unit tests for the version parser and fail-soft paths (injected exec,
  no `mock.module`); extend `health.smoke.test.ts` to assert the field via in-process
  `app.request()`. No existing tests are retired.

**Dependencies:** none
**Branch:** `feat/ccu-1-3-claude-code-version-health`
**Safe to deploy standalone:** yes (additive response field)

## Dependency map

```
[START]
  ├─ CCU-1.1: Pin via Dockerfile ARG + build assertion + disable auto-updater (no deps)
  │     └─ CCU-1.2: Renovate custom manager + followTag stable (needs 1.1)
  └─ CCU-1.3: Report Claude Code version in /health + startup log (no deps)
```

| Task | Depends on | Blocks | HITL |
|---|---|---|---|
| CCU-1.1 | — | 1.2 | |
| CCU-1.2 | 1.1 | — | |
| CCU-1.3 | — | — | |

## HITL scan

No tasks require human steps — no infra/secrets/cloud-console surface, no net-new CI
secrets, no `.claude/**` paths, no production-data backfill.

## Out of scope

- Admin UI display of the agent's Claude Code version (needs an agent→admin reporting
  channel that does not exist today; separate plan-session if wanted).
- Switching to the native installer or distro packages (see CCV plan for the path
  rationale).
