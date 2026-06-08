# Shipwright Harness

[![release](https://img.shields.io/github/v/release/app-vitals/shipwright?sort=semver&label=release&color=34C77B)](https://github.com/app-vitals/shipwright/releases)
[![license: MIT](https://img.shields.io/badge/license-MIT-34C77B)](./LICENSE)
[![built on Claude Code](https://img.shields.io/badge/built%20on-Claude%20Code-34C77B)](https://www.anthropic.com/claude-code)

**The open-source autonomous delivery agent for Claude Code.** A deployable cloud agent and the autonomous coding system that powers it — built on the Shipwright plugin, running on your own codebase.

> 🚧 **Early development.** Shipwright Harness is being built out in this standalone repository and isn't ready for general installation yet. Follow progress in the [issues](https://github.com/app-vitals/shipwright/issues).

> **Brand vs. package:** the project is **Shipwright Harness**; the plugin/package you install is **`shipwright`**.

## Install

```text
/plugin install shipwright@app-vitals/shipwright
```

Requires [Claude Code](https://www.anthropic.com/claude-code). Point it at your own repository — Shipwright is repo-agnostic.

## What is Shipwright Harness?

Two faces, one product:

- **The agent** — deploy it to your cloud (GitHub Actions or self-hosted). It does autonomous coding on your codebase, held to the **same review and test bar as human code**.
- **The system** — the autonomous coding system, built on the Claude Code **`shipwright` plugin**: plan · build · review · metrics. Use it interactively inside Claude Code, or let the agent run it autonomously.

It runs in **your** environment, on **your** codebase — you own it, it's MIT, and it's free.

## What it does

Shipwright turns a feature idea into shipped, reviewed code through a sequence of Claude Code commands — each stage producing a durable artifact the next stage consumes:

- **Brainstorm** an idea into a product spec.
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
| **Plugin (the system)** | The `shipwright` toolchain you `/plugin install` — planning, queue-based execution, review, a test-readiness pipeline, and deploy commands. | 🔨 Building (Phase A) |
| **Metrics dashboard** | A stateless service that reads pipeline analytics (task throughput, CI first-pass rate, review verdicts, estimation accuracy) and renders a dashboard. | 📋 Planned (Phase B) |
| **The agent** | A thin autonomous runner that drives the system on a schedule — pick the next ready task → build → ship a PR → forward metrics — deployable to GitHub Actions or self-hosted. | 📋 Planned (Phase C) |

## Project status

Shipwright Harness is being assembled here in three phases — plugin, then metrics dashboard, then the agent — with merge-blocking CI gates and a single local task runner from the start. See the [`shipwright-oss` milestone](https://github.com/app-vitals/shipwright/milestones) and the [issues](https://github.com/app-vitals/shipwright/issues) for the live roadmap. Installation and local-development instructions will land here as the toolchain becomes runnable.

## Built on Claude Code

Shipwright Harness is a [Claude Code](https://www.anthropic.com/claude-code) plugin through and through — built on it, for it, and used with it daily. If you already run Claude Code, Shipwright is a `/plugin install` away.

## Test system

Shipwright enforces a four-layer test architecture (unit / integration / smoke / e2e) across all three components. Layer boundaries, per-component run commands, speed budgets, and the test-isolation contract are defined in [`docs/test-readiness/test-system.md`](./docs/test-readiness/test-system.md).

## Contributing

Issues and discussion are welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for conventions and workflow, and our [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md). This repository is MIT-licensed and public — please keep contributions free of any proprietary or confidential material.

## License

[MIT](./LICENSE) © 2026 App Vitals
