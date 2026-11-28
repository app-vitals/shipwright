---
name: agent-readiness
description: "Score one repo against the agent-readiness catalogue with the deterministic scorer, post a ReadinessSnapshot and record the run. Requires --repo org/repo. No model judgment, no tasks, no repo files."
argument-hint: "--repo org/repo"
---

# /agent-readiness

Score one repo's agent readiness and record the result in the task store. The scoring is deterministic: no model judgment, no tasks queued, no repo files written.

**Flags:**
- `--repo org/repo` — **required**; without it the command prints a usage error

Invoke the agent-readiness skill.
