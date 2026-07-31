# Shipwright User Guide

A condensed, task-oriented cookbook for operating a Shipwright agent. This file ships inside
the plugin (`plugins/shipwright/`), which is baked into every deployed agent's Docker image —
it is the one piece of documentation guaranteed to be present on any running agent, unlike
`site/` (the marketing/docs site) or `docs/` (repo-level reference docs), neither of which is
baked into the image. Written to stand alone: assume the reader has this file and nothing
else from the repo.

Each section below links to the corresponding page under `site/src/content/docs/` for the
full write-up. Those links are relative paths into the repo and only resolve for a reader who
also has the full repo checked out (e.g. during development) — they're pointers for depth, not
requirements for using this guide.

---

### Where to start

If you're new to a Shipwright deployment: an **agent** is a single deployed unit (Slack app +
runtime + persistent home directory) that drains a **task queue** by running the delivery loop
— build, review, patch, deploy — against one or more GitHub repos. Everything else in this
guide assumes that shape.

Fastest orientation path:

1. Read [`the-plugin.mdx`](../../../site/src/content/docs/the-plugin.mdx) — what the plugin
   is and how its commands/skills/agents fit together.
2. Read [`the-agent.mdx`](../../../site/src/content/docs/the-agent.mdx) — the runtime that
   executes the plugin's commands autonomously.
3. Read [`getting-started.mdx`](../../../site/src/content/docs/getting-started.mdx) — the
   actual install/provision walkthrough.
4. Skim [`introduction.mdx`](../../../site/src/content/docs/introduction.mdx) for the
   one-paragraph pitch and architecture diagram.

If you already have a running agent and just need to get something done, skip straight to the
relevant section below.

---

### Add an env var

Shipwright configuration has **three tiers** — knowing which one you need saves a lot of
confused searching. See `docs/configuration.md` (repo root) for the full authoritative
reference; this is the routing summary.

| Tier | Scope | Where it lives | How to set it |
|---|---|---|---|
| **Plugin Config** | The Shipwright Claude Code plugin (`plugins/shipwright/`) — workspace discovery, task-store backend, `gh` CLI | Plain env vars, e.g. `SHIPWRIGHT_REPO_DIR`, `SHIPWRIGHT_WORKTREE_DIR`, `SHIPWRIGHT_TASK_STORE_URL`, `SHIPWRIGHT_TASK_STORE_TOKEN` | Set in the local shell for direct plugin use, or injected by the provisioner for managed agents |
| **Agent Config** | The agent runtime (`agent/`) and admin service (`admin/`) — model selection, Slack tokens, GitHub auth, Sentry, etc. | Env vars only — no file-based fallback | Admin API (`POST`/`PATCH /agents/:id/envs`) or the admin UI's agent-detail Env Vars card; secrets are masked once set |
| **Policy Config** | Per-agent behavior — review posting, merge permissions, autonomy | `state/agent-policy.md` — Markdown with a YAML front-matter block | Edit the file directly on the agent's workspace; takes effect without a restart or reconfiguring crons |

Rule of thumb: if it's a plugin script behavior (where repos/worktrees live, which task-store
to talk to) → **Plugin Config**. If it's how the agent process itself runs (which model, which
Slack app, which GitHub credentials) → **Agent Config**, set via the admin API/UI, not by
hand-editing a pod. If it's a judgment call about *how autonomous* the agent should be
(auto-post reviews? self-review allowed? how many findings per review?) → **Policy Config**,
`state/agent-policy.md`.

Policy Config fields worth knowing: `auto_post_reviews`, `allowed_events`, `allow_self_review`,
`min_confidence`, `max_findings`, `cleanup_merged_worktrees`, `cleanup_after_days`.

Full reference: [`reference.mdx`](../../../site/src/content/docs/reference.mdx) and
[`configuring-autonomy.mdx`](../../../site/src/content/docs/configuring-autonomy.mdx).

---

### Add an MCP server

Register an MCP server the same way you would in any Claude Code session:

```bash
claude mcp add <name> <command> [args...]
# or, for an HTTP/SSE server:
claude mcp add --transport http <name> <url>
```

This writes the registration into `~/.claude.json`. On a Shipwright agent, `~/.claude.json`
is **not** a real file — it's a symlink to `$AGENT_HOME/claude.json`, set up by
`ensureDotClaudeSymlink()` in `agent/src/setup.ts` at every startup. The same function also
symlinks `~/.claude` → `$AGENT_HOME/dot-claude`. Both live on the agent's persistent volume
(PVC), which survives pod restarts; the container's own filesystem does not.

This matters because `~/.claude.json` is where MCP server registrations actually live —
**outside** `~/.claude/`, as a sibling file — so it needs its own symlink distinct from the
`~/.claude` directory symlink. Without it, a server you register with `claude mcp add` would
be written into the ephemeral image copy of `~/.claude.json` and silently vanish the next time
the pod restarts, because Claude Code would read the fresh image copy instead of the PVC's
persisted one. If an MCP server you registered "disappeared," this symlink is the first thing
to check — confirm `~/.claude.json` is actually a symlink (`ls -la ~/.claude.json`) pointing at
`$AGENT_HOME/claude.json`, and that the target file exists and contains your registration.

Do not point an MCP server registration at a secret directly in the command line if you can
avoid it — prefer an env var reference so the secret doesn't end up readable in `claude mcp
list` output or process listings.

---

### Provision an agent

Agent provisioning is done through the admin console, not a CLI command. Go to
`/admin/provision` and walk the three-step wizard:

1. **Agent** — create a new agent or attach Slack to an existing one.
2. **GitHub Authentication** — a Personal Access Token, or GitHub App credentials (App ID,
   Installation ID, PEM key).
3. **AI Credentials** (optional) — an Anthropic API key or a Claude Code OAuth token.

Provisioning also needs a **Slack App Configuration Token** (`xoxe.xoxp-...`) to create the
Slack app manifest via the Slack API — it's used once and never stored. After the wizard
creates the Slack app, you authorize it (OAuth redirect) and paste in the Socket Mode
`xapp-...` token to finish. On completion the admin service seeds the agent's system crons.

For a self-hosted agent (no managed Kubernetes provisioning), use `/admin/agents/new` instead
— just a name and optional repo list.

Full walkthrough: [`admin-console.mdx`](../../../site/src/content/docs/admin-console.mdx),
section "Provisioning". See also
[`deploying-to-cloud.mdx`](../../../site/src/content/docs/deploying-to-cloud.mdx) for the
underlying Kubernetes provisioning model.

---

### The Shipwright loop, in one paragraph

The delivery loop moves work through four phases — **dev-task** (build and open a PR for a
task), **review** (post findings on an open PR), **patch** (fix a PR in response to review
feedback), and **deploy** (merge and ship an approved PR) — each implemented as an
explicit-target-only command that takes an id or `org/repo#number` and does nothing if
invoked with no target. In production, none of the four self-discovers work: the
`shipwright-loop` cron is the sole dispatcher. Each tick it reads which phases are enabled,
asks each enabled phase's candidate provider for ready work, merges tasks and PRs into one
list, picks the single oldest-ready item via a strict FIFO work-selector (no phase-priority
bias — a stale PR can win over a newer task and vice versa), pre-claims it, and dispatches the
matching command — then repeats immediately until the queue drains dry. `dev-task`, `review`,
and `patch` ship enabled by default; `deploy` and `shipwright-loop` itself ship disabled,
opt-in from the agent's Cron Jobs card.

Full mechanics: [`the-shipwright-loop.mdx`](../../../site/src/content/docs/the-shipwright-loop.mdx).
Ramp-up guidance on which phases to enable when: [`configuring-autonomy.mdx`](../../../site/src/content/docs/configuring-autonomy.mdx).

---

### Debug a stuck PR/task

Work through these in order:

1. **Check the cron run history first.** Admin console → agent detail → **Cron Logs**, or the
   agent list's **Cron Logs** button. Filter by cron and outcome
   (`posted`/`dm`/`silent`/`skipped`/`error`). A `silent` outcome is normal — the tick ran and
   found nothing worth posting. A `skipped` outcome means the cron's `preCheck` script found no
   work and a Claude turn was never spent. Neither is a bug by itself.
2. **If a pipeline cron never shows any runs**, check whether `shipwright-loop` itself is
   enabled — `shipwright-dev-task`/`review`/`patch`/`deploy` are children of `shipwright-loop`
   and never get an independent schedule; their `enabled` toggle only matters once
   `shipwright-loop` reads it.
3. **Find the exact item.** Cron Logs rows show a **Phase** (which of the four phases ran) and
   an **Item** badge (the exact Task/PR dispatched). Filter/scan by Item rather than trying to
   line up timestamps.
4. **Ask the agent to investigate.** Use `/shipwright:investigate-cron` (a dedicated tool) with
   a cron name + approximate time, or a specific PR/task id — it reads the underlying session
   transcript and explains what happened in plain language, no raw log access needed.
5. **Cross-check the work queue.** Admin console → agent detail → **Work Queue** shows the
   agent's self-reported ranked queue across all four phases, with age — useful for seeing
   what the agent thinks is next versus what actually ran.
6. **Query the task/PR record directly** if the UI isn't enough — see "Filter tasks/PRs" below.

Full guide: [`cron-jobs.mdx`](../../../site/src/content/docs/cron-jobs.mdx), section
"Investigating a cron". Day-to-day operator playbook:
[`day-to-day-operations.mdx`](../../../site/src/content/docs/day-to-day-operations.mdx).

---

### Queue new work

Two entry points, meant to be used in sequence:

1. **`/shipwright:prd`** — an interactive PRD session. Asks qualifying questions, researches
   context in the target repo, and produces a `PRODUCT-SPEC.md`. (`/shipwright:brainstorm` is
   a deprecated alias that forwards here.)
2. **`/shipwright:plan-session`** — an engineering planning pass. Reads the product spec,
   explores the codebase, flags complexity, and writes a real task queue directly into the
   task store (`/shipwright:plan-sesh` is an alias). This is what actually populates
   `?ready=true` work for `dev-task` to pick up.

You can also file a single task directly via the task-store API (`POST /tasks`) if you don't
need a full planning pass — see "Filter tasks/PRs" below for the API shape.

Full command reference: [`commands-reference.mdx`](../../../site/src/content/docs/commands-reference.mdx).

---

### Filter tasks/PRs

Both the task store and the PRs surface are plain HTTP APIs behind a Bearer token
(`SHIPWRIGHT_TASK_STORE_URL` + `SHIPWRIGHT_TASK_STORE_TOKEN`).

**Tasks** — `GET /tasks` supports `ready=true` (dependency-satisfied, non-HITL pending work),
`state=` (`ready`/`blocked`/`open`/`closed`/`in_progress`), `status=` (exact status),
`session=`, `assignee=`, `repo=`, `branch=`, `pr=`, `claimedBy=`, plus `limit=`/`offset=` for
pagination.

```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/tasks?ready=true" | jq '.tasks'
```

**PRs** — `GET /prs` supports `repo=`, `prNumber=` (pair with `repo` for one record),
`taskId=`, `state=` (`open`/`merged`/`closed`), `reviewState=`
(`pending`/`in_progress`/`posted`/`approved`), `staged=` (true → only staged/unposted
reviews), plus `limit=`/`offset=`.

```bash
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_TASK_STORE_TOKEN" \
  "$SHIPWRIGHT_TASK_STORE_URL/prs?repo=org/repo&reviewState=pending" | jq '.prs'
```

Both APIs paginate — a naive unpaginated fetch can silently miss records once a repo has more
than a page's worth; loop on `offset` until you've covered `.total`.

Full reference (schemas, status lifecycle, all endpoints):
[`task-store-api.mdx`](../../../site/src/content/docs/task-store-api.mdx) and
[`prs-api.mdx`](../../../site/src/content/docs/prs-api.mdx).

---

### Maintenance crons + why

Beyond the four pipeline phases, an agent type manifest can enable standalone maintenance
crons — each fully self-contained, doing its own discovery with no dependency on
`shipwright-loop`:

| Cron | Default | What it does |
|---|---|---|
| `shipwright-test-readiness` | off | Full test-readiness audit for repos with stale/missing test artifacts. |
| `shipwright-docs-freshness` | off | Refreshes docs that have drifted from the code they describe. |
| `learn-dream` | off | Mines the last day of merged PRs for durable learnings. |
| `dependabot-triage` | off | Reviews and triages open Dependabot PRs. |
| `entropy-patrol-maintenance` | off | Scans for code entropy (dead code, duplication, layering drift) and fixes what's PR-worthy. |
| `error-patrol-maintenance` | off | Scans unresolved Sentry errors and fixes what's PR-worthy. |
| `security-patrol-maintenance` | off | Scans for security vulnerabilities and fixes what's PR-worthy. |
| `consolidation-patrol-maintenance` | off | Proposes consolidation for duplicate patterns that have stabilized over time. |

These exist because the pipeline crons only react to work already in the queue — they don't
notice a stale doc, a growing pile of dead code, or a new Sentry error on their own. The
maintenance crons are the mechanism for finding *new* PR-worthy work proactively rather than
waiting for a human to file it. They ship disabled by default (a new system cron always ships
`enabled: false` so it never fires unexpectedly on an agent that hasn't opted in) — turn them
on per-agent from the Cron Jobs card once you're comfortable with what they'll do.

Every cron — pipeline or maintenance — polls a `preCheck` script first and only spends a
Claude turn if that script produces output; most ticks across most crons cost nothing.

Full reference: [`cron-jobs.mdx`](../../../site/src/content/docs/cron-jobs.mdx).

---

## See also

- [`introduction.mdx`](../../../site/src/content/docs/introduction.mdx) — the one-paragraph pitch and architecture overview
- [`reference.mdx`](../../../site/src/content/docs/reference.mdx) — full env var / config reference
- [`running-locally.mdx`](../../../site/src/content/docs/running-locally.mdx) — running the full dev stack instead of a deployed agent
- `plugins/shipwright/references/principles.md` — code-design and testing principles this agent applies to every change
- `plugins/shipwright/references/toolchain-patterns.md` — how the agent detects a target repo's build/test/lint commands
