---
name: prompt-fix
description: "Read the prompt-audit ledger and queue proposed findings as propose-only task-store tasks (hitl: true unless a human-promoted rule qualifies), each with a measurement plan, blast-radius report and PR must-prove list. Requires /prompt-scan to have been run first. Flags: --dry-run (preview tasks without queueing them), --class <a|b|c|e|f> (one finding class only), --finding <fp> (one specific finding only)."
---

Invoke the `prompt-fix` skill.
