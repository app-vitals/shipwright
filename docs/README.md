# Shipwright Harness — Documentation

Shipwright Harness is the open-source autonomous delivery agent for [Claude Code](https://www.anthropic.com/claude-code): a deployable cloud agent and the autonomous coding system that powers it, built on the `shipwright` plugin.

> 🚧 **Early development.** These docs grow as the toolchain becomes runnable. Start with the [README](../README.md) for the overview and install command.

## Contents

- **[Test system](./test-readiness/test-system.md)** — the four-layer test architecture (unit / integration / smoke / e2e), per-component run commands, speed budgets, and the test-isolation contract.

## Coming as the plugin lands

- **Getting started** — install, configure the task store, point Shipwright at your repo.
- **Command reference** — `brainstorm`, `plan-session`, `dev-task`, `review`, `patch`, `deploy`, and the five-phase test-readiness pipeline.
- **Configuration** — task-store backends (GitHub Issues / local), toolchain detection, environment.
- **Deploying the agent** — running Shipwright autonomously on GitHub Actions or self-hosted.

Track progress on the [`shipwright-oss` milestone](https://github.com/app-vitals/shipwright/milestones).
