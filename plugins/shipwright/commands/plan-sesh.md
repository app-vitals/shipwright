---
description: Alias for /plan-session — engineer planning pass that reads the product spec, explores the codebase, and produces a task queue
arguments:
  - name: repo
    description: The repo to plan work for (e.g., shipwright)
    required: true
  - name: session
    description: A short slug for this planning session (e.g., may-billing-refactor). Used to group tasks and PRs.
    required: true
---

Alias for `/plan-session`. Forwarding to `/plan-session $ARGUMENTS` now.

/plan-session $ARGUMENTS
