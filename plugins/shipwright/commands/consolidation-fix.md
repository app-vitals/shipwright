---
name: consolidation-fix
description: "Read a repo's ready_to_propose consolidation patterns from the task store and queue them as routed tasks (auto, review, or plan), each with a strangler-fig execution plan. Requires --repo org/repo and a prior /consolidation-scan. Flags: --dry-run (preview tasks without queueing them), --pattern {fingerprint} (queue one specific candidate only)."
argument-hint: "--repo org/repo [--dry-run] [--pattern fingerprint]"
---

Invoke the `consolidation-fix` skill. `--repo org/repo` is required; without it the
skill prints a usage error and stops.
