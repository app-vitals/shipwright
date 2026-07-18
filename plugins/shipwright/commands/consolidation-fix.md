---
name: consolidation-fix
description: "Read consolidation-report.md and queue ready_to_propose duplication patterns as task-store tasks, one task per pattern, with a strangler-fig execution plan and per-finding HITL classification. Requires /consolidation-scan to have been run first. Flags: --dry-run (preview tasks without queueing them), --pattern {fingerprint} (queue one specific candidate only)."
---

Invoke the `consolidation-fix` skill.
