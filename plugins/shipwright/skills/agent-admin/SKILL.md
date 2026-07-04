---
name: agent-admin
description: >
  Query and manage Shipwright agents via the admin API — cron jobs, env vars, tool permissions,
  API tokens, and plugins. Use to configure the running agent, manage its schedules, inspect
  another agent's config, or provision a new agent.
---

# Shipwright Agent Admin — Skill

Use this skill to configure and manage Shipwright agents via the admin API. Covers cron jobs,
env vars, tool permissions, API tokens, and plugins for any agent — including yourself.

**Scope boundary:** For delivery pipeline work (planning, code tasks, reviews, deploys) use the
task-store, dev-task, review, or deploy skills. This skill is for agent lifecycle management only.

---

## Authentication

All calls require a Bearer token:

```bash
Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY
```

Your key and base URL are in the agent env:

```bash
echo $SHIPWRIGHT_API_URL        # base URL for the admin API
echo $SHIPWRIGHT_AGENT_API_KEY  # your per-agent API key
echo $SHIPWRIGHT_AGENT_ID       # your own agent ID
```

Verify the service is reachable before doing anything:

```bash
curl -sf "$SHIPWRIGHT_API_URL/health"
```

**Creating new agents** is an admin-only operation — it requires an admin-level key
(`SHIPWRIGHT_ADMIN_API_KEYS` on the server side). All other operations work with the
per-agent API key.

---

## Your Agent Identity

```bash
# Inspect your full config bundle (env vars, crons, tools, plugins)
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/config" | jq .
```

---

## Cron Jobs

Crons drive autonomous operation. The agent syncs from the API every 60 seconds — changes
take effect without a restart.

### System crons vs. custom crons

System crons (`"system": true` in the list output) are seeded from `SYSTEM_CRONS` in the
codebase (`admin/src/system-crons.ts`). Important rules:

- **Cannot be deleted via the API** — the server returns 403. They are recreated on the
  next `reconcile` call.
- **Can be enabled/disabled via `PATCH {"enabled": bool}`** — the enabled-only toggle works
  for both custom and system crons. The enabled state persists across reconcile calls.
- **Content updates go through code** — submit a PR to change `SYSTEM_CRONS`, then call
  `POST .../crons/reconcile` to apply the new definition.

Custom crons (user-created, `"system": false`) can be freely created, updated, and deleted.

```bash
# List all crons for an agent
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons" | jq .

# Create a custom cron (posts to a Slack channel)
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons" \
  -d '{
    "schedule": "0 9 * * 1-5",
    "prompt": "Run the morning brief...",
    "channel": "C123456",
    "enabled": true
  }' | jq .

# Create a cron that DMs a user
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons" \
  -d '{
    "schedule": "0 20 * * 1-5",
    "prompt": "Evening check-in...",
    "user": "U0AALR8M69X",
    "enabled": true
  }' | jq .

# Create a silent cron with a preCheck script
# preCheck formats:
#   "plugin:script.ts"    — resolves to the named plugin's scripts/ dir
#   "./relative/path.ts"  — resolves relative to the agent's workspace root
#   "/absolute/path.ts"   — used as-is
# If preCheck exits 0 with output: that output becomes the prompt.
# If preCheck exits non-0 or produces no output: the tick is skipped entirely.
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons" \
  -d '{
    "schedule": "*/30 * * * *",
    "prompt": "/shipwright:dev-task",
    "silent": true,
    "preCheck": "shipwright:check-dev-task.ts",
    "enabled": true
  }' | jq .

# Update a cron's content — schedule and prompt required together; enabled is optional
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons/{cronId}" \
  -d '{
    "schedule": "0 8 * * 1-5",
    "prompt": "Updated prompt text here",
    "channel": "C123456",
    "preCheck": "shipwright:check-review.ts"
  }' | jq .

# Enable or disable any cron (custom or system) — enabled-only toggle
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons/{cronId}" \
  -d '{"enabled": false}' | jq .

# Set or clear preCheck without touching schedule/prompt — preCheck-only toggle
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons/{cronId}" \
  -d '{"preCheck": "shipwright:check-review.ts"}' | jq .

# Clear preCheck (pass null)
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons/{cronId}" \
  -d '{"preCheck": null}' | jq .

# Update content and toggle enabled in one request
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons/{cronId}" \
  -d '{
    "schedule": "0 8 * * 1-5",
    "prompt": "Updated prompt text here",
    "enabled": true
  }' | jq .

# Delete a custom cron (system crons cannot be deleted — 403)
curl -sf -X DELETE \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons/{cronId}"

# Reconcile system crons — re-seeds from SYSTEM_CRONS, preserving per-agent enabled state
# Run after a shipwright plugin update that changes system cron definitions
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/crons/reconcile" | jq .
# Returns: { "created": N, "updated": N, "deleted": N }
```

**Cron field reference:**

| Field | Required | Description |
|---|---|---|
| `schedule` | Yes | 5-field cron expression (`* * * * *`) |
| `prompt` | Yes | Prompt sent to Claude (fallback when preCheck is set) |
| `channel` | One of† | Slack channel ID for output |
| `user` | One of† | Slack user ID (posts as DM) |
| `silent` | No | `true` = run Claude but post nothing to Slack |
| `enabled` | No | Default `true`. Patchable via enabled-only or full-content PATCH |
| `preCheck` | No | Script — stdout becomes the live prompt; non-0 exit skips the tick |
| `name` | No | Human-readable label (required for system crons) |

† `channel` and `user` are mutually exclusive. At least one is required unless `silent: true`.

---

## Env Vars

Env vars are encrypted at rest. The agent's config-sync loop picks up changes every 60 seconds
— no restart needed.

```bash
# Get all env vars (decrypted)
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/envs" | jq .

# Replace all env vars (bulk POST — overwrites every existing key)
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/envs" \
  -d '{"SLACK_BOT_TOKEN": "xoxb-...", "GH_TOKEN": "ghp_..."}' | jq .

# Merge — update specific keys, leave unmentioned keys unchanged
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/envs" \
  -d '{"GH_TOKEN": "ghp_new_token"}' | jq .

# Delete a single key
curl -sf -X DELETE \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/envs/GH_TOKEN"
```

---

## Tool Permissions

Tool patterns control which Claude Code tools the agent can invoke.

```bash
# List tool patterns
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/tools" | jq .

# Add a tool pattern
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/tools" \
  -d '{"pattern": "Bash(git *)"}' | jq .

# Enable or disable a tool pattern (by toolId from the list)
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/tools/{toolId}" \
  -d '{"enabled": false}' | jq .

# Remove a tool pattern
curl -sf -X DELETE \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/tools/{toolId}"
```

---

## API Tokens

Per-agent tokens for service-to-service or CI calls. The raw token value is returned only
once at creation time — store it immediately.

```bash
# List tokens (metadata only — the stored hash is never returned)
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/tokens" | jq .

# Create a token — save rawToken from the response immediately
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/tokens" \
  -d '{"label": "ci-runner"}' | jq .
# Returns: { token: { id, agentId, label, createdAt }, rawToken: "sw_..." }

# Revoke a token
curl -sf -X DELETE \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/tokens/{tokenId}"
```

---

## Plugins

Plugins installed on the agent determine which skills and commands are available.

**`name` is the canonical Claude install spec** — exactly the string you'd pass to
`claude plugin install`:

- `"<plugin>@<marketplace>"` for a marketplace-scoped plugin (e.g. `"shipwright@shipwright"`,
  `"my-plugin@my-marketplace"`). The config bundle splits on the first `@`, and the harness
  reassembles `<plugin>@<marketplace>` to install it.
- A bare `"<plugin>"` defaults to the bundled `shipwright` marketplace.

Do **not** use an npm-scoped form like `@my-marketplace/my-plugin` — `claude plugin install`
does not accept scoped plugin identifiers, and the agent would fail to install it.

```bash
# List installed plugins
curl -sf -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/plugins" | jq .

# Install a plugin from the bundled shipwright marketplace (or re-add to pin a version)
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/plugins" \
  -d '{"name": "shipwright", "version": "4.27.2"}' | jq .

# Install a plugin from a different marketplace baked into the agent image
# (use the canonical "<plugin>@<marketplace>" spec)
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/plugins" \
  -d '{"name": "my-plugin@my-marketplace"}' | jq .

# Update a plugin version
# name goes in the query param — a spec like my-plugin@org/marketplace can contain "/" which breaks path matching
curl -sf -X PATCH \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/plugins?name=shipwright" \
  -d '{"version": "4.27.2"}' | jq .

# Remove a plugin
curl -sf -X DELETE \
  -H "Authorization: Bearer $SHIPWRIGHT_AGENT_API_KEY" \
  "$SHIPWRIGHT_API_URL/agents/$SHIPWRIGHT_AGENT_ID/plugins?name=shipwright"
```

---

## Creating a New Agent (Admin Only)

Two paths, depending on whether the agent is self-hosted.

**Non-self-hosted (preferred):** use the inline provisioning wizard at `/admin/provision`.
Select the "Create new agent" toggle (instead of "Use existing agent") to walk through
Slack app creation, GitHub auth, and AI credentials in one flow.

**Self-hosted:** the wizard doesn't apply — register the agent directly via the admin API.
Requires an admin-level API key configured in `SHIPWRIGHT_ADMIN_API_KEYS` on the server.

```bash
curl -sf -X POST \
  -H "Authorization: Bearer $SHIPWRIGHT_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  "$SHIPWRIGHT_API_URL/agents" \
  -d '{"name": "my-agent", "slackId": "U0AALR8M69X"}' | jq .
# Returns: { id, name, slackId, createdAt }
```

After creating a self-hosted agent via the raw API, set env vars, add tool patterns, install
plugins, and seed crons using the endpoints documented elsewhere in this skill.

---

## Metrics API

The metrics service exposes task-store-backed pipeline data. Endpoints require Bearer auth.

| Endpoint | What it returns |
|---|---|
| `GET /metrics/summary` | Cycle time, task counts, FTQ rate |
| `GET /metrics/trends` | Metrics over time, groupable by day/week/month |
| `GET /metrics/features` | Per-feature task and CI data |
| `GET /metrics/queue` | Queue funnel and cycle breakdown |
| `GET /metrics/tokens` | Token usage by agent and session type |

For structured analysis, use `/shipwright:metrics` instead — it reads local JSONL files
from `planning/*/metrics.jsonl`, computes fix cascade rates, FTQ rate, CI gate, and other
quality metrics, and produces a formatted report with actionable recommendations.

---

## API Reference

The full admin API schema is committed to the repository at `admin/openapi.json`. For
interactive schema exploration (endpoints, request/response shapes, validation rules), access
the live `/doc` endpoint on a running admin service:

```bash
open "$SHIPWRIGHT_API_URL/doc"
```

> **Note:** The `/doc` endpoint is not yet wired in the production admin service — it is a
> planned follow-up. Use `admin/openapi.json` as the schema reference in the meantime.

---

## Safety Rules

- **Confirm before any DELETE** — token revocations and plugin removals are not easily reversed.
- **Never attempt to delete system crons** — the API returns 403. Use `PATCH {"enabled": false}` to disable them instead.
- **Content PATCH requires `schedule` + `prompt` together** — you must resend both even when changing only one. For toggling only enabled, use `{"enabled": bool}` with no schedule/prompt.
- **POST to `/envs` replaces everything** — use PATCH to update specific keys without wiping others.
- **Token raw values are shown once** — save `rawToken` from the create response before closing the session.
- **If the API isn't responding**, stop and tell the user — don't guess or retry blindly.
