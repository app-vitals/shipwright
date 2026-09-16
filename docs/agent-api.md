# Agent Admin API

The Shipwright admin service exposes a CRUD API for managing agents and their resources. It is the control plane used by the admin UI, the [`agent-admin`](../plugins/shipwright/skills/agent-admin/SKILL.md) skill, and the provisioning pipeline.

Base path: `/agents`

**Full endpoint reference** — every route, parameter, request/response shape, and status code — lives in the generated [`admin/openapi.json`](../admin/openapi.json) spec. **Practical usage** — curl-based examples for common agent-management calls — lives in the [`agent-admin`](../plugins/shipwright/skills/agent-admin/SKILL.md) skill.

This page covers only the auth model and behavioral nuance the spec doesn't carry. Cron jobs and cron runs are documented in [`docs/agent-api-ops.md`](./agent-api-ops.md). The allowed-tools list, API tokens, plugins, chat token usage, and the work-queue snapshot are documented in [`docs/agent-api-resources.md`](./agent-api-resources.md).

---

## Authentication

Three auth paths are checked in order:

1. **Admin key** — `Authorization: Bearer <key>` where the key matches an entry in `SHIPWRIGHT_ADMIN_API_KEYS`. Sets `isAdmin=true`, bypasses all per-agent checks.
2. **Per-agent bearer token** — `Authorization: Bearer <token>` where the token is a per-agent DB token scoped to a specific agent ID. Sets `isAdmin=false`, restricts access to that agent's own routes (`403` on cross-agent access).
3. **Session cookie** — `admin_session` httpOnly JWT verified with `SHIPWRIGHT_SESSION_SECRET`. Sets `isAdmin=true`.

If an `Authorization` header is present but the token is invalid in both token paths, the request is rejected with `401` (no fallthrough to cookie). Missing auth returns `401`. Cross-agent access with a per-agent token returns `403`.

Routes marked **admin-only** in the OpenAPI spec require `isAdmin=true`. Per-agent bearer tokens cannot call these routes.

---

## Agents

`GET`/`PATCH`/`DELETE /agents[/:id]`, `POST /agents/:id/provision`, and `POST /agents/reconcile` are fully described in the OpenAPI spec — including the rollback-guarded provisioning block. Field semantics the spec doesn't carry:

Agent **creation** is not part of this JSON API — there is no `POST /agents` route. New agents are created exclusively via the web UI form at `/admin/agents/new`, which seeds AgentTool/AgentPlugin/AgentMember rows from the selected Agent Type manifest and (for non-self-hosted agents) provisions the Kubernetes workload. See the [`agent-admin`](../plugins/shipwright/skills/agent-admin/SKILL.md) skill for the walkthrough.

- **`reviewAuthorAllowlist`** vs **`patchAuthorAllowlist`** are not symmetric: an empty `reviewAuthorAllowlist` means "all authenticated users" (fail-open), while an empty `patchAuthorAllowlist` means "self-authored PRs only" — `patchAuthorAllowlist` is additive on top of that, enforced at runtime by `agent/src/check-patch.ts`, which merges allowlisted-author PRs into the self-authored candidate pool and deduplicates by `(repo, PR number)`.
- **`slackId`** is normally resolved and persisted automatically via `auth.test` right after Slack OAuth completes; it's directly settable only to backfill it for agents that connected Slack before that fix shipped.
- **`DELETE /agents/:id`**'s `manualStepsRequired` response entries flag state with no automated revocation path: hand-pasted secrets (`GH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and any other `AgentEnv` row with `secret: true`) must be revoked by hand at their respective provider, plus a Slack-app entry when `SLACK_APP_ID` is set but no `xoxpToken` was supplied to the delete call.

---

## Environment variables

Env vars are stored encrypted (AES-256-GCM) and decrypted on read. `POST /agents/:id/envs` bulk-replaces every env var; `PATCH /agents/:id/envs` updates specific keys without touching others.

---

## Runtime config

```
GET /agents/:id/config
```

Polled by the agent harness on startup and during its config sync loop — the one route on this page the harness itself calls, as opposed to the admin UI or provisioning pipeline. Returns the full config bundle: decrypted env vars, allowed-tools patterns, installed plugins, scoped repos, `reviewAuthorAllowlist`/`patchAuthorAllowlist`/`restrictSlackToMembers`, and derived `memberEmails` (empty unless `restrictSlackToMembers` is `true` and members are configured). Returns `404` if the agent doesn't exist.

---

## Related

- Cron jobs and cron runs: [`docs/agent-api-ops.md`](./agent-api-ops.md)
- Allowed-tools, API tokens, plugins, chat token usage, work-queue snapshot: [`docs/agent-api-resources.md`](./agent-api-resources.md)
- Practical curl usage: the [`agent-admin`](../plugins/shipwright/skills/agent-admin/SKILL.md) skill
