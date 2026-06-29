# Shipwright Harness

[![release](https://img.shields.io/github/v/release/app-vitals/shipwright?sort=semver&label=release&color=34C77B)](https://github.com/app-vitals/shipwright/releases)
[![license: MIT](https://img.shields.io/badge/license-MIT-34C77B)](./LICENSE)
[![built on Claude Code](https://img.shields.io/badge/built%20on-Claude%20Code-34C77B)](https://www.anthropic.com/claude-code)
[![live proof dashboard](https://img.shields.io/badge/proof-live%20dashboard-34C77B)](https://proof.shipwrightharness.com/public/dashboard)

**The open-source autonomous delivery agent for Claude Code.** A deployable cloud agent and the autonomous coding system that powers it — built on the Shipwright plugin, running on your own codebase.

<p align="center">
  <img src="assets/demo.gif" alt="Shipwright Harness in a Claude Code terminal: install, then plan → build → review → ship a task end to end." width="900" />
  <br />
  <em>Plan → build → review → ship — one task through the pipeline. (Illustrative.)</em>
</p>


> **Brand vs. package:** the project is **Shipwright Harness**; the plugin/package you install is **`shipwright`**.

## Install

```text
/plugin install shipwright@app-vitals/shipwright
```

Requires [Claude Code](https://www.anthropic.com/claude-code). Point it at your own repository — Shipwright is repo-agnostic.

**Deploying the services to Kubernetes?** The `shipwright` Helm chart is published to a Helm repo on each chart version bump:

```bash
helm repo add shipwright https://app-vitals.github.io/shipwright
helm install my-release shipwright/shipwright --namespace shipwright --create-namespace
```

See [`docs/deploy-kubernetes.md`](./docs/deploy-kubernetes.md) for end-to-end deployment guides (Minikube / GKE / EKS), and [`docs/helm-repo.md`](./docs/helm-repo.md) for the published-repo flow and how publishing is triggered.

## Quickstart

You can run the **metrics dashboard locally today** — **offline by default**, with **no PostHog key, no accounts, and no database**. One copy-paste prompt sequences the two execution contexts (terminal shell + an in-session slash command) and opens the dashboard.

Paste this into a **Claude Code** session:

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

Step 1 runs in your **terminal**; step 2 is a slash command that runs **inside the Claude Code session**. The dashboard comes up at <http://localhost:3460/dashboard>.

Prerequisites: [Claude Code](https://www.anthropic.com/claude-code), [git](https://git-scm.com/downloads), [Bun](https://bun.sh), and [go-task](https://taskfile.dev/installation/). Full details, the `QUICKSTART_SKIP_SERVE` CI guard, and the offline-default explanation live in [`docs/quickstart.md`](./docs/quickstart.md).

**Full dev stack**

Want the complete local stack — metrics dashboard, admin UI, task-store, and the Shipwright agent running in Docker? This requires [tmux](https://github.com/tmux/tmux), [Docker](https://docs.docker.com/get-docker/), and a local [PostgreSQL](https://www.postgresql.org/) instance (port 5432). Paste this into a **Claude Code** session:

```text
Set up the full Shipwright Harness dev stack locally.

Prerequisites: tmux, Docker, PostgreSQL running on localhost:5432, Bun, go-task.

1. In a terminal, clone and set up:
     git clone https://github.com/app-vitals/shipwright.git && cd shipwright && task setup

2. Copy the env example and add your auth token:
     cp state/dev-agent.env.example state/dev-agent.env
   Open state/dev-agent.env and set one of:
     CLAUDE_CODE_OAUTH_TOKEN=<your token>   (run: claude /oauth-token)
     ANTHROPIC_API_KEY=<your key>           (https://console.anthropic.com/ → API Keys)

3. Launch the full stack (6-pane tmux session):
     task stack

   This opens a tmux session named "shipwright" with 6 panes:
     metrics (:3460)  admin (:3001)  task-store (:3002)  agent (:3000)  chat  logs

4. Open the dashboard in your browser:
     http://localhost:3460/dashboard

5. Inside a Claude Code session:
     /plugin install shipwright@app-vitals/shipwright

To stop: tmux kill-session -t shipwright
```

## What is Shipwright Harness?

Two faces, one product:

- **The agent** — deploy it to your cloud (GitHub Actions or self-hosted). It does autonomous coding on your codebase, held to the **same review and test bar as human code**.
- **The system** — the autonomous coding system, built on the Claude Code **`shipwright` plugin**: plan · build · review · metrics. Use it interactively inside Claude Code, or let the agent run it autonomously.

It runs in **your** environment, on **your** codebase — you own it, it's MIT, and it's free.

## What it does

Shipwright turns a feature idea into shipped, reviewed code through a sequence of Claude Code commands — each stage producing a durable artifact the next stage consumes:

- **Write a PRD** for your idea — a structured product spec ready for /plan-session.
- **Plan** the spec into a queue of well-scoped, dependency-ordered tasks (tracked as **GitHub Issues** — the queue lives where your team already works).
- **Execute** the next ready task — build, test, and open a PR.
- **Review** the PR with policy-controlled, inline feedback.
- **Ship** the merged change.

## Why Shipwright Harness

- **Free and open-source (MIT)** — the own-it alternative to closed, hosted coding agents. No rented infrastructure, no lock-in.
- **Runs in your environment, your cloud** — your code never leaves your control.
- **The same quality bar as human code** — tests land with the code, gated by a five-phase **test-readiness** pipeline, so an autonomous agent can be trusted.
- **Metrics on your own pipeline** — first-time-quality rate, estimation accuracy, and review-verdict trends, measured on your delivery.
- **Built on Claude Code** — we use it every day, and Shipwright extends it rather than replacing it.

## Components

| Component | What it does | Status |
|---|---|---|
| **Plugin (the system)** | The `shipwright` toolchain you `/plugin install` — planning, queue-based execution, review, a test-readiness pipeline, and deploy commands. | ✅ Available |
| **Metrics dashboard** | A stateless service that reads pipeline analytics (task throughput, CI first-pass rate, review verdicts, estimation accuracy) and renders a dashboard. Run locally with `task api` or `task ui` (offline mode, no secrets needed). | ✅ Available |
| **Shipwright agent** | A thin autonomous runner that drives the system on a schedule — pick the next ready task → build → ship a PR → forward metrics — deployable to GitHub Actions or self-hosted. | ✅ Available |

## The workflow

```
/shipwright:prd            → a product spec
/shipwright:plan-session   → a dependency-ordered task queue
/shipwright:dev-task       → build + test + open a PR for the next ready task
/shipwright:review         → policy-controlled PR review
/shipwright:patch          → address review findings / failing CI
/shipwright:deploy         → merge + deploy
```

Tasks are tracked as GitHub Issues, so the queue lives where your team already works.

## Project status

**See it live** — Shipwright builds itself. The [public metrics dashboard](https://proof.shipwrightharness.com/public/dashboard) shows live pipeline data for this repo: first-time quality, cycle time, estimation accuracy, and task throughput — all generated by the same agent and plugin you're reading about.

Shipwright Harness is live — plugin, metrics dashboard, and the Shipwright agent all ship with v0.1.0. See the [issues](https://github.com/app-vitals/shipwright/issues) for the live roadmap and upcoming improvements.

The metrics dashboard is runnable locally today — the [Quickstart](#quickstart) wraps this in one copy-paste prompt (`./scripts/quickstart.sh`). The underlying tasks:

```bash
task setup      # bun install
task api        # start metrics dashboard in offline mode → http://localhost:3460/dashboard
task dev        # dev supervisor: starts metrics + Ctrl-C kills all children
task stack      # full dev stack in a tmux session (6 panes) — requires tmux
```

`task stack` brings up a single tmux session (`shipwright`) with a 6-pane dashboard: **metrics** (SQLite, :3460), **admin** (CRUD API + UI, :3001), **task-store** (:3002), the **agent** with the dev `/chat` endpoint enabled (:3000), the **chat** REPL, and a scratch **logs** shell. It runs a Prisma `migrate deploy` preflight first so the admin service's Postgres schema is up to date; on macOS the preflight checks Postgres is reachable and offers to run the needed `brew`/`createdb` commands if it isn't. `task stack` requires `tmux`; if it isn't installed, use `task dev` (the no-tmux fallback that starts the metrics dashboard).

See [`docs/quickstart.md`](./docs/quickstart.md) for the full onboarding prompt and offline-default behavior.

## Built on Claude Code

Shipwright Harness is a [Claude Code](https://www.anthropic.com/claude-code) plugin through and through — built on it, for it, and used with it daily. If you already run Claude Code, Shipwright is a `/plugin install` away.

## Test system

Shipwright enforces a four-layer test architecture (unit / integration / smoke / e2e) across all three components. Layer boundaries, per-component run commands, speed budgets, and the test-isolation contract are defined in [`docs/test-readiness/test-system.md`](./docs/test-readiness/test-system.md).

## Configuration

All configuration options — plugin env vars, `.shipwright.json` keys, agent env vars, and policy fields — are documented in [`docs/configuration.md`](./docs/configuration.md).

## Contributing

Issues and discussion are welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for conventions and workflow, and our [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md). This repository is MIT-licensed and public — please keep contributions free of any proprietary or confidential material.

## License

[MIT](./LICENSE) © 2026 App Vitals
