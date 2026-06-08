# Quickstart

> Get the Shipwright Harness metrics dashboard running locally in one prompt — offline by default, no external accounts or secrets.

## What you can run today

The **metrics dashboard** runs locally right now in **offline mode**: it serves from fixtures with **no PostHog key, no accounts, and no database**. That is the core promise of this quickstart — a running dashboard at `http://localhost:3460/dashboard` from a single copy-paste prompt.

The plugin (Phase A) and the Shipwright agent (Phase C) are still being built; see the [README](../README.md) and the [`shipwright-oss` milestone](https://github.com/app-vitals/shipwright/milestones) for live status.

## Prerequisites

| Tool | Why | Install |
|---|---|---|
| **Claude Code** | Runs the `/plugin install` step of the prompt. Not needed by `scripts/quickstart.sh`. | <https://www.anthropic.com/claude-code> |
| **git** | Clone the repo. | <https://git-scm.com/downloads> |
| **Bun** | Runtime + package manager for all workspaces. | <https://bun.sh> |
| **go-task** (`task`) | The single local entrypoint (`task setup`, `task dev`). | <https://taskfile.dev/installation/> |

## The one-prompt onboarding

Paste this into a **Claude Code** session pointed at where you want to work. It sequences **two execution contexts** — shell steps run in a terminal, and one step runs *inside* the Claude Code session:

```text
Set up Shipwright Harness locally and open the metrics dashboard.

1. In a terminal, run:
     git clone https://github.com/app-vitals/shipwright.git && cd shipwright && ./scripts/quickstart.sh
   This checks prerequisites, installs dependencies (task setup), and starts the
   metrics dashboard in offline mode (no accounts or secrets needed). Leave it running.

2. Inside this Claude Code session, install the plugin:
     /plugin install shipwright@app-vitals/shipwright

3. Open the dashboard in your browser:
     http://localhost:3460/dashboard
```

### Which lines run where

| Step | Where it runs | Command |
|---|---|---|
| 1. Clone + bootstrap + serve | **Terminal** (shell) | `git clone … && cd shipwright && ./scripts/quickstart.sh` |
| 2. Install the plugin | **Inside the Claude Code session** | `/plugin install shipwright@app-vitals/shipwright` |
| 3. Open the dashboard | **Browser** | `http://localhost:3460/dashboard` |

The distinction matters: step 1 is a shell command, step 2 is a slash command that only works **inside** an interactive Claude Code session (it is not a terminal command).

## What `scripts/quickstart.sh` does

Run it from **inside** the cloned repo (the prompt's step 1 clones and `cd`s for you first). It is **idempotent** — safe to re-run:

1. Verifies prerequisites (`git`, `bun`, `task`) and fails with an install pointer if any is missing.
2. Runs `task setup` (idempotent `bun install` across all workspaces).
3. Starts the dashboard with `task dev` (the dev supervisor; Ctrl-C stops it) and points you at `http://localhost:3460/dashboard`.

## Offline by default

`task dev` (and `task api` / `task ui`) bake in `METRICS_OFFLINE=true`. In offline mode the dashboard serves from fixtures, so you need **no PostHog project, no accounts service, and no database** to run it. Live external calls only happen when you explicitly set the relevant env vars — local-first is the default.

## CI / testing: `QUICKSTART_SKIP_SERVE`

The final `task dev` step is long-running (it blocks while the server runs), which would hang CI. Set the `QUICKSTART_SKIP_SERVE` env var to a non-empty value to run every deterministic step (prereq checks + `task setup` + the next-steps message) and then exit 0 **without** starting the server:

```bash
QUICKSTART_SKIP_SERVE=1 ./scripts/quickstart.sh
```

This is primarily for CI and the smoke test (`scripts/quickstart.smoke.test.ts`) — it lets the deterministic onboarding path be verified without blocking on a live server. In normal use, leave it unset.

## What this doesn't cover automatically

The two networked / interactive steps of the prompt are **not** part of the script (and are not run in CI):

- The `git clone` itself — it lives in the prompt's shell line, before the script runs.
- The `/plugin install shipwright@app-vitals/shipwright` step — it runs inside an interactive Claude Code session, not a shell.

Both are documented in the prompt above; only the deterministic shell portion is scripted and tested.
