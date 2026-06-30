# Shipwright Harness — Documentation

Shipwright Harness is the open-source autonomous delivery system in your own environment: a deployable cloud agent and the autonomous coding system that powers it, built on the `shipwright` plugin.

> 🚧 **Early development.** These docs grow as the toolchain becomes runnable. Start with the [README](../README.md) for the overview and install command.

## Contents

- **[Quickstart](./quickstart.md)** — prerequisites, step-by-step setup (clone → quickstart.sh → plugin install → task dev), and the copy-paste session prompt.
- **[Architecture](./architecture.md)** — the three-artifact design (plugin → metrics → agent), supporting surfaces, and workspace layout.
- **[Testing](./testing.md)** — the four-layer test model (unit / integration / smoke / e2e), run commands, speed budgets, and the isolation contract.
- **[Metrics dashboard](./metrics.md)** — the provider-agnostic metrics service (fixtures / task-store): JSON endpoints, dashboard, auth, and environment.
- **[Shipwright agent](./agent.md)** — the autonomous runner: runtime + admin APIs, data model, and environment.
- **[Deploying to Kubernetes](./deploy-kubernetes.md)** — Helm chart deployment guides for Minikube, GKE (Gateway API + cert-manager), and EKS (ALB), plus the agent provisioning model and auth modes.
- **[Test system](./test-readiness/test-system.md)** — the full authoritative test blueprint (source for [Testing](./testing.md)).
- **[Configuration](./configuration.md)** — all configuration options: plugin env vars, agent env vars, and policy fields.

## Command reference

The plugin's commands (`prd`, `plan-session`, `dev-task`, `review`, `patch`, `deploy`, the five-phase test-readiness pipeline, and more) are documented at their source: see [`plugins/shipwright/README.md`](../plugins/shipwright/README.md) and [`plugins/shipwright/CLAUDE.md`](../plugins/shipwright/CLAUDE.md).

## Coming as the toolchain matures

- **Getting started** — install, configure the task store, point Shipwright at your repo.
- **Deploying the agent** — running Shipwright autonomously on GitHub Actions or self-hosted.

Track progress on the [`shipwright-oss` milestone](https://github.com/app-vitals/shipwright/milestones).
