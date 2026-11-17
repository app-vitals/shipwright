---
description: Alias for /plan-session — engineer planning pass that plans a session's unplanned specs across its target repos and produces a task queue
arguments:
  - name: session
    description: A short slug for this planning session (e.g., may-billing-refactor). Used to group tasks and PRs. In the two-argument form `{repo} {session}` the repo (org/repo) comes first and is home for a new session or an added target for an existing one.
    required: true
  - name: repos
    description: Optional `--repos a,b` — extra org/repo targets, unioned with the repos of the session's unplanned specs
    required: false
  - name: owner
    description: Optional `--owner email` — the requester recorded as the owner of the plan's tasks
    required: false
  - name: initiative
    description: Optional `--initiative id` — the initiative or idea task this session fulfils
    required: false
---

Alias for `/plan-session`. Forwarding to `/plan-session $ARGUMENTS` now.

/plan-session $ARGUMENTS
