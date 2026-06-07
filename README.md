# Shipwright

[![Release](https://img.shields.io/github/v/release/app-vitals/shipwright?sort=semver)](https://github.com/app-vitals/shipwright/releases)

**A Claude Code plugin toolchain for the full delivery loop — spec → plan → execute → review → deploy.** Plus a metrics dashboard and a reference agent for running it autonomously.

> 🚧 **Early development.** Shipwright is being built out in this standalone repository and isn't ready for general installation yet. Follow progress in the [issues](https://github.com/app-vitals/shipwright/issues).

## What is Shipwright?

Shipwright turns a feature idea into shipped, reviewed code through a sequence of Claude Code slash commands — each stage producing a durable artifact the next stage consumes:

- **Brainstorm** an idea into a product spec.
- **Plan** the spec into a queue of well-scoped, dependency-ordered tasks.
- **Execute** the next ready task — build, test, and open a PR.
- **Review** the PR with policy-controlled, inline feedback.
- **Deploy** the merged change.

It's repo-agnostic: install the plugin and point it at your own repository.

## Components

| Component | What it does | Status |
|---|---|---|
| **Plugin** | The toolchain you `/plugin install` — planning, queue-based execution, review, a test-readiness pipeline, and deploy commands. | 🔨 Building (Phase A) |
| **Metrics dashboard** | A stateless service that reads pipeline analytics (task throughput, CI first-pass rate, review verdicts, estimation accuracy) and renders a dashboard. | 📋 Planned (Phase B) |
| **Reference agent** | A thin autonomous runner that drains the task queue on a schedule — pick → build → ship a PR → forward metrics. | 📋 Planned (Phase C) |

## The workflow

```
/shipwright:brainstorm     → a product spec
/shipwright:plan-session   → a dependency-ordered task queue
/shipwright:dev-task       → build + test + open a PR for the next ready task
/shipwright:review         → policy-controlled PR review
/shipwright:patch          → address review findings / failing CI
/shipwright:deploy         → merge + deploy
```

Tasks are tracked as GitHub Issues, so the queue lives where your team already works.

## Project status

Shipwright is being assembled here in three phases — plugin, then metrics dashboard, then reference agent — with merge-blocking CI gates and a single local task runner from the start. See the [`shipwright-oss` milestone](https://github.com/app-vitals/shipwright/milestones) and the [issues](https://github.com/app-vitals/shipwright/issues) for the live roadmap.

Installation and local-development instructions will land here as the toolchain becomes runnable.

## Test system

Shipwright enforces a four-layer test architecture (unit / integration / smoke / e2e) across all three components. Layer boundaries, per-component run commands, speed budgets, and the test isolation contract are defined in [`docs/test-readiness/test-system.md`](./docs/test-readiness/test-system.md).

## Contributing

Issues and discussion are welcome. This repository is MIT-licensed and destined to be public — please keep contributions free of any proprietary or confidential material.

## License

[MIT](./LICENSE) © 2026 App Vitals
