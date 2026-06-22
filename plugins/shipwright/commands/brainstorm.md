---
description: "[DEPRECATED] Renamed to /prd. This stub forwards invocations for backward compatibility."
arguments:
  - name: folder-name
    description: Name of the planning session folder under planning/ (e.g., april-2026-workspace-switcher)
    required: true
---

> **Deprecated:** `/brainstorm` has been renamed to `/prd`. This command will be removed in a future release.
> Please update any cron prompts or scripts that reference `/shipwright:brainstorm` to use `/shipwright:prd` instead.

Forwarding to `/prd $ARGUMENTS` now.

/prd $ARGUMENTS
