---
name: entropy-fix
description: "Route a repo's PR-worthy entropy violations as task-store tasks (auto / review / plan), one task per golden principle, and record the patrol run. Requires --repo org/repo and /entropy-scan first. Flags: --dry-run (preview without queueing or recording), --rule {id} (queue one specific rule only)."
argument-hint: "--repo org/repo [--dry-run] [--rule id]"
---

Invoke the `entropy-fix` skill.
