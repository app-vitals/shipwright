# Shipwright Harness — Documentation

Shipwright Harness is the open-source autonomous delivery agent for [Claude Code](https://www.anthropic.com/claude-code): a deployable cloud agent and the autonomous coding system that powers it, built on the `shipwright` plugin.

> 🚧 **Early development.** These docs grow as the toolchain becomes runnable. Start with the [README](../README.md) for the overview and install command.

## Contents

- **[Architecture](./architecture.md)** — the three-artifact design (plugin → metrics → agent), supporting surfaces, and workspace layout.
- **[Testing](./testing.md)** — the four-layer test model (unit / integration / smoke / e2e), run commands, speed budgets, and the isolation contract.
- **[Metrics dashboard](./metrics.md)** — the stateless PostHog-backed service: JSON endpoints, dashboard, auth, and environment.
- **[Reference agent](./agent.md)** — the autonomous runner: runtime + admin APIs, data model, and environment.
- **[Test system](./test-readiness/test-system.md)** — the full authoritative test blueprint (source for [Testing](./testing.md)).

## Command reference

The plugin's commands (`brainstorm`, `plan-session`, `dev-task`, `review`, `patch`, `deploy`, the five-phase test-readiness pipeline, and more) are documented at their source: see [`plugins/shipwright/README.md`](../plugins/shipwright/README.md) and [`plugins/shipwright/CLAUDE.md`](../plugins/shipwright/CLAUDE.md).

## Coming as the toolchain matures

- **Getting started** — install, configure the task store, point Shipwright at your repo.
- **Configuration** — task-store backends (GitHub Issues / local), toolchain detection, environment.
- **Deploying the agent** — running Shipwright autonomously on GitHub Actions or self-hosted.

Track progress on the [`shipwright-oss` milestone](https://github.com/app-vitals/shipwright/milestones).
