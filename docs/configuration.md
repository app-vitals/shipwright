# Configuration

> Single authoritative reference for all Shipwright configuration options, organized by scope: [Plugin Config](#plugin-config), [Agent Config](#agent-config), and [Policy Config](#policy-config).

## Precedence

When the same option can be set multiple ways, resolution order is:

```
env var  >  built-in default
```

**Env vars are the only configuration path.** All Shipwright configuration is supplied via env vars — injected by the admin service for managed agents, or set in the local environment for direct plugin use.

---

## Plugin Config

Configuration for the Shipwright Claude Code plugin (`plugins/shipwright/`). These options control workspace discovery, task-store backend, and GitHub CLI integration.

### Env vars

| Name | Type | Default | Description |
|---|---|---|---|
| `SHIPWRIGHT_REPOS_DIR` | `string` | `<workspace>/repos` | Fallback repos directory for plugin scripts when workspace discovery finds no `repos/` dir. |
| `SHIPWRIGHT_REPO_DIR` | `string` | `$HOME/src` | Where the plugin commands (`dev-task`, `patch`, `deploy`) look for repo clones. The provisioner injects `<AGENT_HOME>/workspace/repos` for managed agents so clones live on the PVC. |
| `SHIPWRIGHT_WORKTREE_DIR` | `string` | `$HOME/worktrees` | Where the plugin commands create git worktrees. The provisioner injects `<AGENT_HOME>/workspace/worktrees` for managed agents — `$HOME` is ephemeral overlay storage in the agent container, and worktrees there can trigger pod eviction. |
| `GH_CMD` | `string` | `gh` | Override the `gh` CLI executable. Useful in environments where `gh` is installed to a non-default path. |
| `AGENT_HOME` | `string` | `/data/agent-home` | Persistent storage root for workspace files, mise caches, and `~/.claude`. Set in the agent container; also used by plugin scripts for workspace discovery. |
| `WORKSPACE_PATH` | `string` | — | Direct workspace path override. Takes precedence over `AGENT_HOME`-based discovery when set. |
| `SHIPWRIGHT_TASK_STORE_URL` | `string` | — | Base URL of the Shipwright task-store HTTP service — the only task-store backend. Required (alongside `SHIPWRIGHT_TASK_STORE_TOKEN`) for `dev-task`, `review`, `patch`, `deploy`, and the `task-store` skill to function. |
| `SHIPWRIGHT_TASK_STORE_TOKEN` | `string` | — | Bearer token for task-store API access. See the [Metrics & Admin & Chat & Task-Store services](#metrics--admin--chat--task-store-services) table below for how it's minted and injected for managed agents. Env-var-only (secret). |
| `SENTRY_ORG` | `string` | — | Sentry organization slug (e.g., `acme-corp`). Required (alongside `SENTRY_AUTH_TOKEN`) for the `error-scan` and `error-resolve` skills to query the Sentry Issues API. When unset, the error-scan and error-resolve skills exit early with a skipped status. Env-var-only (secret — exposes the org name). |
| `SENTRY_AUTH_TOKEN` | `string` | — | Sentry API token for authentication. Required (alongside `SENTRY_ORG`) for the `error-scan` and `error-resolve` skills to access Sentry project data and issues. Must have permissions to query projects and issues (and mutate issue state for error-resolve) in the target org. Env-var-only (secret). |

---

## Agent Config

Configuration for the Shipwright agent runtime (`agent/` and `admin/`). All options are env vars — there is no file-based fallback for agent config. Secrets must be supplied as env vars and are never stored in config files.

### Per-agent fields

Unlike the env vars below, these fields live on the Agent database record, not the environment — they're set via the admin API (`POST`/`PATCH /agents/:id`) or the admin UI, not env vars. See [`docs/agent-api.md`](./agent-api.md#agents) for the full request/response contract.

| Field | Type | Default | Description |
|---|---|---|---|
| `repos` | `string[]` | `[]` | `org/repo` strings this agent is scoped to. Seeded from the Agent Type manifest at creation, editable via `PATCH /agents/:id` or the admin UI. |
| `authorAllowlist` | `string[]` | `[]` | GitHub login strings permitted to trigger this agent's review/dev-task work. **Empty means unfiltered** — every authenticated author is allowed. Settable at creation (admin UI create-form field) and editable afterward (admin UI agent-detail page's add/delete rows, or `PATCH /agents/:id`). For local dev, `hitl.ts`'s `SHIPWRIGHT_HITL_AUTHORS` env var is the equivalent — it stays in sync with the persisted record via `PATCH` (see the `SHIPWRIGHT_HITL_AUTHORS` row under [Dev-only](#dev-only)). |

### Claude / Anthropic

| Name | Type | Default | Description |
|---|---|---|---|
| `ANTHROPIC_MODEL` | `string` | `claude-sonnet-4-6` | Claude model used for each agent invocation. |
| `ANTHROPIC_FALLBACK_MODEL` | `string` | — | Fallback model if the primary is unavailable. |
| `ANTHROPIC_EFFORT_LEVEL` | `string` | — | Effort/thinking level passed to Claude (e.g. `extended`, `auto`, `none`). |
| `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` | `number` | `3600000` | Hard **ceiling** timeout in milliseconds for a single `claude -p` session spawned by the agent runner (`agent/src/claude.ts`). This is a backstop, not the primary timeout — see `SHIPWRIGHT_CLAUDE_IDLE_TIMEOUT_MS` below for that. When a session's total elapsed time exceeds this ceiling, the process is killed and a `ClaudeTimeoutError` (`reason: "ceiling"`) is raised, even if stdout has stayed continuously active (idle timer kept resetting) — this only fires for a continuously-active-but-never-converging session. Defaults to 3 600 000 ms (1 hr) — corresponds to `DEFAULT_CLAUDE_TIMEOUT_MS` in `@shipwright/lib/claim-ttl`. Raise it for long sessions that keep polling CI after implementing so the worker can mark its task complete instead of being SIGKILLed mid-poll. **When raising this, raise `SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS` in step** (keep the ~5 min buffer above this value via `CLAIM_TTL_BUFFER_MS`); otherwise the stale-claim reaper abandons the claim and re-dispatches a duplicate run before the longer session finishes. This var lives in the agent's own env (`agent.extraEnv` in the Helm chart) — the agent runner reads it directly. It is **not** read by task-store; task-store has no in-process way to see the agent's value (the two are separate deployables with independent env surfaces). Task-store now ships `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` set to 1 hr by default in its own env (via `taskStore.extraEnv` in the chart) to run the `checkClaimTtlBuffer` startup check against its own `SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS` — see that row for details. In an N:1 fleet (many agents sharing one task-store), if your agents are provisioned with different `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` values (set per-agent via the admin service's `POST`/`PATCH /agents/:id/envs`), raise the value in task-store's env to the **maximum** timeout across the whole fleet, not any single agent's value, so the check correctly validates against the longest-running agent. **Early session capture (CSI-1.1, extended by CSI-1.2):** `ClaudeTimeoutError` (both `reason: "ceiling"` and `reason: "idle"`) and `ClaudeRunError` now include a `sessionId` field captured from the leading `system`/`init` stream-json line if one was received before the error fired, allowing session tracking for failed runs that never emit a terminal `result` event. CSI-1.2 extends capture to persist the session ID even when the initial attempt fails before retry logic runs, so the next Slack reply on the same thread can resume the session instead of starting fresh. Runs without any `system` line (immediate kill) will have `sessionId` undefined. |
| `SHIPWRIGHT_CLAUDE_IDLE_TIMEOUT_MS` | `number` | `1500000` | Idle-reset timeout in milliseconds for a single `claude -p` session (`agent/src/claude.ts`) — this is the **primary** timeout in practice. Cleared and restarted on every stdout line the session emits; fires (killing the process and raising `ClaudeTimeoutError` with `reason: "idle"`) only when the session goes silent for this long, regardless of how much ceiling headroom (`SHIPWRIGHT_CLAUDE_TIMEOUT_MS`) remains. Defaults to 1 500 000 ms (25 min), calibrated from a 900-session log analysis (p99 inter-line gap 713s, largest legitimate single-gap 1303s from an `Agent()` subagent delegation). Falls back to the default when unset or not a positive integer. Lives in the agent's own env (`agent.extraEnv` in the Helm chart); not read by task-store. |
| `ANTHROPIC_API_KEY` | `string` | — | Anthropic API key. Env-var-only (secret). |
| `CLAUDE_CODE_OAUTH_TOKEN` | `string` | — | Claude Code OAuth token (alternative to `ANTHROPIC_API_KEY`). Env-var-only (secret). |

### Slack

All Slack vars are env-var-only (secrets). The agent does not function as a Slack bot without them.

| Name | Type | Default | Description |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | `string` | required for Slack | Slack bot user OAuth token (`xoxb-...`). |
| `SLACK_APP_TOKEN` | `string` | required for Slack | Slack app-level token for Socket Mode (`xapp-...`). |
| `SLACK_SIGNING_SECRET` | `string` | required for Slack | Used to verify incoming Slack request signatures. |
| `SLACK_ADMIN_TOKEN` | `string` | — | Optional admin-level token for privileged Slack operations. |
| `SLACK_ALERT_CHANNEL` | `string` | — | Slack channel ID to post system alerts (e.g. startup errors). |
| `SLACK_OWNER_USER` | `string` | — | Slack user ID of the agent owner, used for DM fallback. |

### GitHub

Provide either the GitHub App vars (recommended) or `GH_TOKEN` (PAT). App auth is used when the App env vars are present; `GH_TOKEN` is the fallback.

| Name | Type | Default | Description |
|---|---|---|---|
| `GH_APP_ID` | `string` | required for App auth | GitHub App ID (integer as string). Env-var-only (secret). |
| `GH_APP_INSTALLATION_ID` | `string` | required for App auth | Installation ID for the target org/repo. Env-var-only (secret). |
| `GH_APP_PRIVATE_KEY` | `string` | required for App auth | PEM private key for the GitHub App (newlines may be `\n`-escaped). Env-var-only (secret). |
| `GH_TOKEN` | `string` | — | Personal Access Token. Used only when GitHub App vars are absent. Env-var-only (secret). |

### Shipwright platform

| Name | Type | Default | Description |
|---|---|---|---|
| `SHIPWRIGHT_API_URL` | `string` | — | Base URL of the Shipwright admin service, used by the agent entrypoint to fetch config at startup. |
| `SHIPWRIGHT_AGENT_ID` | `string` | — | The agent's ID in the Shipwright platform. Also settable via `--agent-id` CLI flag. |
| `SHIPWRIGHT_AGENT_API_KEY` | `string` | — | Bearer token for the config fetch at startup (`/agents/:id/config` and `/agents/:id/crons`). Also settable via `--api-key`. |
| `SHIPWRIGHT_PR_STATE_RECONCILER_INTERVAL_MS` | `number` | `2700000` (45 min) | Interval in milliseconds for the PR state reconciler (`agent/src/pr-state-reconciler.ts`), started in `agent/src/index.ts` alongside the config-sync and cron-sync intervals. On each tick it runs two independent entry-point functions (each with its own error handling — a failure in one does not prevent the other). **Entry point 1 (reconcilePrState):** lists every task-store PR record still `state:"open"` per repo, checks each against live GitHub state via `gh pr view`, and PATCHes the record's `state`/`mergedAt` (plus defensively clearing claim fields) when GitHub reports the PR as merged or closed — a crash backstop for the *business state* fields, distinct from `SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS`'s *claim* fields. Scoped to the agent's live-configured repos (WL-4.4) so a repo cloned locally but absent from the agent's scope is never reconciled. Internally runs two nested passes: **Pass 1a (reconcileOrphanedTasks)** scans every task-store Task with `status:"pending"` or `status:"in_progress"` that has a `branch` set but no `pr` linked (TCR-1.2), queries live GitHub for an open PR on that branch, and PATCHes the task to `status:"pr_open"` with the found PR number — healing tasks left in pending/in_progress after a dev-task session opens a real PR on GitHub but crashes before the final task-store status PATCH. Includes the bundle-mate guard (BBR-1.1): when multiple tasks share the same branch, the auto-heal is skipped entirely rather than guessing which sibling's work the PR contains. Scoped to the agent's live-configured repos via `getScopedRepos()` (PSR-1.3) — out-of-scope tasks are skipped entirely (zero GitHub calls). This pass runs causally first, healing pending/in_progress → pr_open drift so tasks are ready for Pass 1b. **Pass 1b (reconcilePrOpenTasks)** scans every task-store Task with `status:"pr_open"`, resolves its linked PR (directly via task.pr or via branch fallback via `gh pr list --head`), checks GitHub for merge, and PATCHes the task to merged, also backfilling the linked PullRequest record's taskId when needed (DSR-1.1). Both the direct path (when task.pr is set and task.branch also exists) and the branch-fallback path include the bundle-mate guard (BBR-1.1, extended to the direct path via RDG-1.1): when multiple tasks share the same branch, the merge-advance is skipped entirely rather than guessing which sibling's work the PR contains — a trailing sibling on a multi-task branch must not ride a bundle-mate's real merge to "merged" status purely because its own `task.pr` field resolves to MERGED on GitHub without its own `startedAt` ever being set (confirmed live: IC-1.2/1.3/1.4, DPF-2.2, PW-1.2, SBA-1.2). Scoped to the agent's live-configured repos via `getScopedRepos()` (PSR-1.3) — out-of-scope tasks are skipped entirely (zero GitHub calls). **Entry point 2 (reconcileReviewState):** runs two sub-passes inside a single `reconcileReviewState()` function with no new setInterval tick, scoped to the agent's live-configured repos via `getScopedRepos()` (PSR-1.3). (a) Lists `state:"open" && reviewState:"pending"` records per repo, fetches each PR's reviews via GitHub GraphQL, and PATCHes `reviewState` to terminal when reviews at the head commit are APPROVED or match a clean-approve body — healing records stuck at pending when an out-of-band reviewer posts directly to GitHub (CHU-2.2). (b) Lists `state:"open" && reviewState:"posted"` records per repo, fetches each PR's reviews via GitHub GraphQL, and when no review exists at the current head commit (a new commit landed since the posted verdict was made), PATCHes `reviewState` back to "pending" so check-review.ts re-selects the PR for a fresh review (CHU-2.4 — the mirror-image healing direction of sub-pass (a)). Deliberately a longer interval than the 60s config/cron syncs since it only needs to run every 30-60 minutes. Only started when `runtimeClient` and `SHIPWRIGHT_AGENT_ID` are configured. |
| `SHIPWRIGHT_RECONCILER_DELAY_MS` | `number` | `300` (300 ms) | Delay in milliseconds inserted between GitHub API calls in the PR state reconciler's each gh-call-issuing loop (PSR-1.2), spread across every record iteration. When a reconcile pass lists 70+ PR records for checking, this delay spreads their GitHub queries out over ~21 seconds instead of firing them in a sub-second burst, preventing exhaustion of the shared `GH_TOKEN`'s rate limits (confirmed live: tight bursts exhausted the GraphQL limit for ~9 minutes, blocking sibling agents' dispatch work). Production implementations use a real `setTimeout`-backed pause; tests inject a no-op. Env-var-only; read once at process start, allowing runtime tuning for ops without a code change. Recommended range: 200–500 ms depending on the agent's GitHub call concurrency and the limit headroom of the token's plan. |
| `SHIPWRIGHT_RECONCILER_UPDATED_SINCE_WINDOW_MS` | `number` | `21600000` (6h) | Recency window (PSR-1.1) for the PR state reconciler's `updatedSince` filter, applied to `reconcilePrOpenTasks`, `reconcileOrphanedTasks`, `reconcilePrState`'s open-record scan, and `reconcileReviewState`'s pending-record scan — each pass only re-fetches records/tasks updated within this window instead of unconditionally rescanning every record every tick, avoiding the same GraphQL rate-limit exhaustion `SHIPWRIGHT_RECONCILER_DELAY_MS` mitigates. Deliberately wide relative to `SHIPWRIGHT_PR_STATE_RECONCILER_INTERVAL_MS`'s 30-60 minute tick interval: these four passes exist specifically to heal a task-store record whose `updatedAt` will never change again once truly stuck by a crash/hang, so the window only needs to survive a missed or delayed tick (restart, deploy) rather than exclude every record that isn't brand-new. `listPostedReviewRecords` (CHU-2.4) is permanently exempt from this filter regardless of window size — see the module doc comment in `agent/src/pr-state-reconciler.ts`. Env-var-only; read once at process start. |
| `SHIPWRIGHT_RECONCILER_SCOPE_DEGRADED_RETRY_DELAY_MS` | `number` | `1000` (1s) | Bounded pause before `listAllTasksForBranch`'s single retry (RSG-1.2) of a task-store `GET /tasks?repo=&branch=` response that reported `scopeDegraded:true` (RSG-1.1 — set when the calling agent token's own repo-scope resolver call failed, which forces `repos` to `[]` server-side and can silently under-count or zero out real bundle-mate tasks sharing a branch). Both BBR-1.1 bundle-mate guard call sites (`reconcileOrphanedTask` and `reconcilePrOpenTask`'s branch-fallback path) depend on this count being trustworthy before auto-healing a branch-only PR match; if the retried response is STILL degraded, the true sibling count is treated as unknown and the auto-heal is skipped (same effective outcome as a confirmed `>1` sibling count), logging a message distinct from the existing "N tasks share this branch" skip so the two causes stay distinguishable in practice. A non-degraded response (including a legitimate 0- or 1-task result) never triggers this delay at all. Production uses a real `setTimeout`-backed pause (reusing the same injected `delay` dep PSR-1.2 already threads through this file); tests inject a no-op. Env-var-only; read once at process start. |

### Loop orchestrator

| Name | Type | Default | Description |
|---|---|---|---|
| `SHIPWRIGHT_LOOP_EMPTY_BACKOFF_MS` | `number` | `300000` (5 min) | Duration in milliseconds for the empty-queue backoff window (SKT-2.2). When the loop has collected zero candidates for `SHIPWRIGHT_LOOP_EMPTY_BACKOFF_ATTEMPTS` consecutive ticks, the next tick skips all candidate collection (no GitHub calls, no task-store queries) and remains idle for this duration before resuming normal work selection — a low-cost way to reduce redundant external API calls when the queue is genuinely drained. Read fresh on every tick (never cached) so an operator's env change takes effect on the very next tick without an agent restart. See also `SHIPWRIGHT_LOOP_EMPTY_BACKOFF_ATTEMPTS`. Env-var-only. |
| `SHIPWRIGHT_LOOP_EMPTY_BACKOFF_ATTEMPTS` | `number` | `3` | Consecutive empty ticks required to trigger the empty-queue backoff window (SKT-2.2). When the loop collects zero candidates for this many ticks in a row, the following tick enters backoff (skips all candidate collection) for `SHIPWRIGHT_LOOP_EMPTY_BACKOFF_MS` milliseconds. A tick that dispatches at least one item resets this counter immediately — real work interrupts a backoff on the very next tick. Read fresh on every tick (never cached) so an operator's env change takes effect on the very next tick without an agent restart. See also `SHIPWRIGHT_LOOP_EMPTY_BACKOFF_MS`. Env-var-only. |

### Server

| Name | Type | Default | Description |
|---|---|---|---|
| `PORT` | `number` | `3000` | Hono server port. Applies to the admin service (`admin/src/main.ts`). |
| `SHIPWRIGHT_HEALTH_PORT` | `number` | `3459` | Dedicated health server port for K8s liveness probes. Started in-process by `entrypoint-main.ts` before the startup sequence so the probe is always reachable during init. |
| `NODE_ENV` | `string` | — | Runtime environment. Set to `production` to enforce production-safety guards (blocks `ADMIN_DEV_AUTH`). |
| `SENTRY_DSN` | `string` | — | Sentry error reporting DSN for the agent (`agent/src/index.ts`). When set, the agent initializes Sentry (`initSentry`) and reports unhandled cron handler errors via `Sentry.captureException` before the existing `console.error` and 500 response. When unset, Sentry is fully inert (no init call, zero telemetry). Unlike other Shipwright services, the agent is **not chart-provisioned** — it's provisioned per-tenant by `KubernetesAgentProvisioner` — so operators set `SENTRY_DSN` directly in the agent's own env, the same way `ANTHROPIC_API_KEY` is set. **This must be present at pod startup** — `initSentry` and the health server's `Sentry` wiring are evaluated once at module load, before the 60-second config sync runs; delivering `SENTRY_DSN` via the agent config bundle instead of a pod env var leaves Sentry inactive for the pod's lifetime with no warning, and requires a pod restart to take effect. Env-var-only (secret). |
| `SENTRY_ENVIRONMENT` | `string` | — | Sentry environment tag for the agent. Defaults to `NODE_ENV` if unset, then `production`. Passed as the `environment` field in Sentry init options. Optional alongside `SENTRY_DSN`. |

### Metrics & Admin & Chat & Task-Store services

| Name | Type | Default | Description |
|---|---|---|---|
| `DATABASE_URL_SHIPWRIGHT_ADMIN` | `string` | required | Postgres connection string for the admin service schema (e.g. `postgresql://user:pass@host:5432/db`). |
| `DATABASE_URL_SHIPWRIGHT_CHAT` | `string` | required | Postgres connection string for the chat service schema. **Must be a separate database** from the admin and task-store services — the schema forbids sharing. |
| `SHIPWRIGHT_CHAT_AGENTS_URL` | `string` | — | Base URL of the Shipwright agents service, used by the chat service to resolve agent token scopes. When set alongside `SHIPWRIGHT_CHAT_AGENTS_API_KEY`, the chat service calls this URL to fetch the repos an agent token may access. Optional — when unset, agent tokens default to empty repo lists and scope resolution is disabled. |
| `SHIPWRIGHT_CHAT_AGENTS_API_KEY` | `string` | — | Bearer token for the chat service to call the agents service. Required alongside `SHIPWRIGHT_CHAT_AGENTS_URL` to enable scope resolution. Env-var-only (secret). |
| `SHIPWRIGHT_CHAT_SERVICE_URL` | `string` | — | Base URL of the Shipwright chat service (e.g. `http://chat:3000` or `https://chat.example.com`). When set alongside `SHIPWRIGHT_CHAT_SERVICE_TOKEN`, the agent starts the chat poll loop in Step 6b to poll for pending messages and reply. Optional — omit to disable the chat poll loop. |
| `SHIPWRIGHT_CHAT_SERVICE_TOKEN` | `string` | — | Bearer token for the agent to call the chat service. Required alongside `SHIPWRIGHT_CHAT_SERVICE_URL` to enable the chat poll loop. The chat service validates this token; tokens are scoped to their agent ID. Env-var-only (secret). When `SHIPWRIGHT_K8S_PROVISIONING=enabled`, this token is minted per-agent by the admin provisioner and stored in the agent Secret (key `chat-service-token`); injected into the agent Deployment via this env var. |
| `SHIPWRIGHT_CHAT_POLL_INTERVAL_MS` | `number` | `5000` | Poll interval in milliseconds for the chat poll loop (Step 6b). The agent claims one unclaimed message per thread per poll cycle and runs it through Claude. Only read when `SHIPWRIGHT_CHAT_SERVICE_URL` and `SHIPWRIGHT_CHAT_SERVICE_TOKEN` are configured. |
| `SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN` | `string` | — | Bearer token for admin-side chat-service token minting. Required (alongside `SHIPWRIGHT_CHAT_SERVICE_URL`) to enable per-agent provisioning on `POST /agents` and full agent deletion via `DELETE /agents/:id`. The admin service uses this token to call chat-service `POST /tokens` and `DELETE /tokens/:id` during agent lifecycle (mint on provision, revoke on delete). Env-var-only (secret). |
| `DATABASE_URL_SHIPWRIGHT_TASK_STORE` | `string` | required | Postgres connection string for the task-store service. **Must be a separate database** from the admin and chat services — the schema forbids sharing. Read by `@shipwright/task-store` and `@shipwright/agent`. |
| `SHIPWRIGHT_TASK_STORE_URL` | `string` | — | Base URL of the Shipwright task-store service (e.g. `http://task-store:3000` or `https://tasks.example.com`). When set alongside `SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN`, the admin service wires per-agent tokens during provisioning and injects the URL + token into agent Deployment env vars (`SHIPWRIGHT_TASK_STORE_URL`, `SHIPWRIGHT_TASK_STORE_TOKEN`). Agents use these to authenticate with the task-store API when claiming tasks or updating status. |
| `SHIPWRIGHT_TASK_STORE_PUBLIC_URL` | `string` | — | Externally-reachable base URL of the task-store advertised in the admin mint-token success page's copy-paste env block (printed as `SHIPWRIGHT_TASK_STORE_URL`). Set this to the public route a local/laptop agent can resolve — e.g. `https://<host>/task-store` when the chart's `taskStore.expose.enabled` is on. The admin service's own in-cluster task-store calls (token minting + task CRUD) always use the internal `SHIPWRIGHT_TASK_STORE_URL`; only the displayed value changes. When unset, the env block falls back to `SHIPWRIGHT_TASK_STORE_URL` (current behavior). Set via the chart value `admin.taskStorePublicUrl`. |
| `SHIPWRIGHT_TASK_STORE_TOKEN` | `string` | — | Bearer token for task-store API access. Minted per-agent by the admin provisioner and stored in the agent Secret (key `task-store-token`); injected into the agent Deployment via `SHIPWRIGHT_TASK_STORE_TOKEN` env var. Used by agents to claim tasks, update status, query the task queue, and pre-claim PRs. Read directly by the agent's in-process candidate providers in `agent/src/check-helpers.ts` — `createTaskStoreClient()` (used by `check-dev-task.ts` for dev-task pre-claiming (CBD-1.2) and by `loop-orchestrator.ts` for PR pre-claiming (CBD-1.3)), `createPrRecordQuery()` (used by `check-review.ts`, `check-patch.ts`, and `check-deploy.ts`), and `createTaskStatusQuery()` (used by `check-review.ts` and `check-patch.ts` to source candidate age from task.createdAt per LPF-3.2) — for the `shipwright-loop` cron. Env-var-only (secret). |
| `SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN` | `string` | — | Bearer token for admin-side task-store token minting. Required (alongside `SHIPWRIGHT_TASK_STORE_URL`) to enable per-agent provisioning on `POST /agents` and full agent deletion via `DELETE /agents/:id`. The admin service uses this token to call task-store `POST /tokens` and `DELETE /tokens/:id` during agent lifecycle (mint on provision, revoke on delete). Env-var-only (secret). |
| `SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS` | `number` | `3900000` | Milliseconds a claim (Task or PR review/patch/deploy) remains valid without a heartbeat. When an agent's last heartbeat exceeds this TTL, the claim will be abandoned and the record eligible for re-claiming by another agent. A single unified TTL covers both Task claims (`/shipwright:dev-task`) and PR claims — derived from `DEFAULT_CLAIM_TTL_MS` in `@shipwright/lib/claim-ttl` (`DEFAULT_CLAUDE_TIMEOUT_MS` + `CLAIM_TTL_BUFFER_MS`, or 1 hr + 5 min buffer = 65 min total). **Startup check:** at boot, `task-store/src/main.ts` reads `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` from task-store's own env (see that row) and calls the pure `checkClaimTtlBuffer(ttlMs, claudeTimeoutMs)` (`task-store/src/claim-ttl-buffer-check.ts`) against the reaper's resolved `ttlMs`. The chart now ships `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` set to 1 hr by default, so this check runs by default and will `console.warn` if the configured TTL doesn't cover the default (or your configured) `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` plus the standard 5-minute buffer, naming both values so an operator can raise the TTL before claims are silently reaped mid-session. **N:1 fleet note:** since one task-store can serve many agents, each with its own `SHIPWRIGHT_CLAUDE_TIMEOUT_MS` (set per-agent via the admin service's `POST`/`PATCH /agents/:id/envs`), if your agents have different timeout values, raise the value in task-store's env to the **maximum** timeout across the whole fleet — not any single agent's value — so the check correctly validates against the longest-running agent. |
| `SHIPWRIGHT_TASK_STORE_AGENTS_URL` | `string` | — | Base URL of the Shipwright agents service. When set alongside `SHIPWRIGHT_TASK_STORE_AGENTS_API_KEY`, the task-store service uses it to resolve agent tokens to their scoped repos. Without both vars, the scope resolver is disabled and agent tokens default to empty repo lists. Optional — not required when agents do not need repo-scoping. |
| `SHIPWRIGHT_TASK_STORE_AGENTS_API_KEY` | `string` | — | Bearer token for the task-store service to call the agents service. Required alongside `SHIPWRIGHT_TASK_STORE_AGENTS_URL` to enable scope resolution. Used by the task-store's `createScopeResolver()` to fetch agent repos. Follows the `SHIPWRIGHT_TASK_STORE_*` naming convention to avoid collision with the `agent-admin` skill's `SHIPWRIGHT_AGENT_API_KEY`. Env-var-only (secret). |
| `SENTRY_DSN` | `string` | — | Sentry error reporting DSN for the task-store, metrics, and admin services. When set, these services initialize Sentry and mount error-capture middleware that reports 5xx and unhandled exceptions. When unset, Sentry is disabled (zero telemetry overhead). The same DSN is also used by the Hono middleware (`@sentry/hono`) to initialize Sentry with scrubbing hooks that redact secrets and environment-specific tags. Env-var-only (secret). Each service reads its own `SENTRY_DSN` from its own env — see also the agent's `SENTRY_DSN` row under [Agent Config](#agent-config). |
| `SENTRY_ENVIRONMENT` | `string` | — | Sentry environment tag for the task-store, metrics, and admin services. Defaults to `NODE_ENV` if unset, then `production`. Passed as the `environment` field in Sentry init options. Optional alongside `SENTRY_DSN`. |
| `SHIPWRIGHT_MCP_SERVER_TOKEN` | `string` | — | Bearer token required on every inbound request to the MCP server (except `/health`). Read by `mcp-server/src/main.ts` at startup; the service fails closed and refuses to start if unset. Prevents unauthorized access to the tool proxy surface, since the server holds `SHIPWRIGHT_TASK_STORE_TOKEN` and proxies authenticated calls into the task store on behalf of any connected client. Bearer auth uses constant-time comparison to avoid side-channel leaks. Env-var-only (secret). |
| `SHIPWRIGHT_SESSION_SECRET` | `string` | — | HS256 secret for the `admin_session` cookie. The admin service signs it on Google-OAuth login; the metrics service verifies it to reuse the same session (the two must share the value). |
| `SHIPWRIGHT_ENCRYPTION_KEY` | `string` | — | 64-char hex (32 bytes) for AES-256-GCM encryption of secrets at rest. **If unset, secrets are stored in plain text** — always set this in any real deployment. |
| `SHIPWRIGHT_ADMIN_ALLOWED_EMAILS` | `string` | — | Comma-separated list of Google email addresses permitted to log in to the admin UI. |
| `SHIPWRIGHT_ADMIN_APP_BASE_URL` | `string` | `http://localhost:{PORT}` | Public base URL of the admin service, used to construct the Google OAuth redirect URI. |
| `SHIPWRIGHT_ADMIN_PUBLIC_REPO` | `string` | — | Repository slug (format: `org/repo`) scoped for the public read-only task board. When set, `GET /public/tasks` displays tasks for this repo only, unauthenticated. When unset, the board renders in degraded mode (empty table + warning). Optional — omit to disable the public board. |
| `SHIPWRIGHT_ADMIN_TZ` | `string` | `America/Los_Angeles` | IANA timezone name (e.g. `America/New_York`) for date/time display in the admin UI. When unset, defaults to `America/Los_Angeles`. |
| `METRICS_DASHBOARD_URL` | `string` | `/dashboard` | URL for the "Metrics" toolbar link in the admin UI. Defaults to `/dashboard` (same-host relative path, suitable when the ingress routes `/dashboard` to the metrics service on the same public hostname). Set to an absolute URL when the metrics service runs on a different host or port (e.g. in local dev: `http://localhost:3460/dashboard`). |
| `METRICS_ADMIN_APP_URL` | `string` | `""` | The reverse of `METRICS_DASHBOARD_URL`: base URL of the admin console for the metrics **dashboard** toolbar's Agents/Tasks/PRs links. Defaults to empty (same-host relative links, suitable for single-host ingress). Set to an absolute URL when the admin console runs on a different origin than the metrics dashboard (e.g. in local `task stack`: `http://localhost:3001`), otherwise those links 404 on the metrics origin. Distinct from the server-to-server `METRICS_ADMIN_URL`. |
| `GOOGLE_CLIENT_ID` | `string` | — | Google OAuth 2.0 client ID. Required for the admin UI login flow. |
| `GOOGLE_CLIENT_SECRET` | `string` | — | Google OAuth 2.0 client secret. Required for the admin UI login flow. |

### Agent provisioning (admin service)

Controls how the admin service provisions the Kubernetes workload backing each agent on `POST /agents` and tears it down as part of `DELETE /agents/:id`. When provisioning is disabled (the default), create/delete only write the database row and trigger optional external cleanup (task-store/chat-service token revocation) if their URLs and tokens are configured — no cluster is required.

| Name | Type | Default | Description |
|---|---|---|---|
| `SHIPWRIGHT_K8S_PROVISIONING` | `string` | — | Set to `enabled` to provision a real Kubernetes PersistentVolumeClaim + Secret + Deployment per agent via `KubernetesAgentProvisioner`. Any other value (or unset) selects the no-op provisioner, preserving DB-only create/delete behavior. |
| `SHIPWRIGHT_K8S_NAMESPACE` | `string` | — | Target namespace for per-agent PersistentVolumeClaim, Secret, and Deployment. When set (explicit value), use that namespace (cross-namespace provisioning). When unset, fall back to the downward API (the pod's own release namespace — the zero-config default). Only read when provisioning is enabled. |
| `SHIPWRIGHT_AGENT_IMAGE` | `string` | — | Agent container image (without tag) used for the provisioned Deployment. Only read when provisioning is enabled. |
| `SHIPWRIGHT_AGENT_IMAGE_TAG` | `string` | `latest` | Image tag joined as `image:tag` for the provisioned Deployment. Only read when provisioning is enabled. |
| `SHIPWRIGHT_ADMIN_DEPLOYMENT_NAME` | `string` | — | Name of the admin Deployment, used as the `ownerReference` target so per-agent resources are garbage-collected with the admin Deployment. Only read when provisioning is enabled. |
| `SHIPWRIGHT_ADMIN_DEPLOYMENT_UID` | `string` | — | UID of the admin Deployment, paired with `SHIPWRIGHT_ADMIN_DEPLOYMENT_NAME` for the `ownerReference`. Only read when provisioning is enabled. |
| `SHIPWRIGHT_AGENT_REPLICAS` | `number` | `1` | Replica count for the provisioned agent Deployment. Only read when provisioning is enabled. |
| `SHIPWRIGHT_AGENT_PVC_STORAGE_GI` | `number` | `40` | Storage size in Gi for the per-agent persistent home directory (PVC). Only read when provisioning is enabled. Must be large enough to hold mise caches and workspace files across pod restarts. |
| `SHIPWRIGHT_AGENT_PVC_NAME_TEMPLATE` | `string` | — | Template for deriving the PVC name from the agent's human-readable name. Use `{name}` as the placeholder — it is substituted with the agent's name (slug) when provided, or the sanitized agent ID otherwise. Example: `my-org-agent-{name}-home` → `my-org-agent-okwow-home`. When unset (the default), PVCs are named `{sanitizedAgentId}-home`. Useful when migrating from static agents whose PVCs were created with a fixed naming convention. Only read when provisioning is enabled. |

### Workspace and tooling

| Name | Type | Default | Description |
|---|---|---|---|
| `AGENT_HOME` | `string` | `/data/agent-home` | Persistent storage root. Mount a PVC here in Kubernetes so mise caches, workspace files, and `~/.claude` survive pod restarts. |
| `MISE_DATA_DIR` | `string` | `<AGENT_HOME>/mise` | Mise data directory. On first startup, seeded from the image's default mise location so baked tools survive pod restarts. Override only if needed. |
| `MISE_CACHE_DIR` | `string` | `<AGENT_HOME>/mise/cache` | Override the mise cache directory. Auto-derived from `AGENT_HOME`. |
| `XDG_CACHE_HOME` | `string` | `<AGENT_HOME>/cache` | Override the XDG cache directory. Auto-derived from `AGENT_HOME`. |
| `XDG_DATA_HOME` | `string` | `$HOME/.local/share` | Override the XDG data directory. Used to locate the mise data dir (`$XDG_DATA_HOME/mise`) when seeding a fresh PVC. |
| `SHIPWRIGHT_STARTUP_TIMEOUT_MS` | `number` | `180000` | Maximum milliseconds the entrypoint startup sequence may take before the agent exits. Override to a lower value (e.g. `10000`) in dev for faster fail-fast feedback. |
| `AGENT_ALLOWED_TOOLS` | `string` (JSON array) | — | JSON array of allowed Claude tool patterns. Set by the admin service config sync; do not set manually in production. |

### Voice

Optional. When unset, voice transcription and synthesis are disabled.

| Name | Type | Default | Description |
|---|---|---|---|
| `GROQ_API_KEY` | `string` | — | Groq API key for voice processing. Env-var-only (secret). |
| `ELEVENLABS_API_KEY` | `string` | — | ElevenLabs API key for speech synthesis. Env-var-only (secret). |
| `ELEVENLABS_VOICE_ID` | `string` | — | ElevenLabs voice ID to use for synthesis. |
| `PIPER_VOICE` | `string` | `en_US-hfc_female-medium` | Piper voice to use for local (offline) speech synthesis. Validated at startup by discovery-based scan of the baked voices directory (`/app/agent/voices/`, hardcoded — not env-configurable); valid values depend entirely on what the image bakes. An unrecognized value logs loudly (naming the requested voice and every voice actually discovered) and falls back to the default rather than crashing. |
| `WHISPER_SERVICE_URL` | `string` | — | URL of a Whisper transcription service for voice input. |

TTS defaults to the self-hosted Piper binary baked into the agent image (no network call) — `synthesizeSpeech` in `agent/src/voice.ts` only calls ElevenLabs when `ELEVENLABS_API_KEY` is set, and falls back to Piper otherwise. So the zero-egress voice configuration is Whisper STT + no ElevenLabs key; setting `ELEVENLABS_API_KEY` (either provider) or `GROQ_API_KEY` (STT) each independently reintroduce network egress to that third party. See [`deploy-kubernetes.md`](./deploy-kubernetes.md#agent-voice-stttts) for the full egress matrix.

On Kubernetes these env vars are a deploy-time option of the Helm chart rather than something you set by hand. Set `agent.voice.enabled=true` and `agent.voice.provider` (`whisper` | `groq`); the chart then injects the matching env into provisioned agent pods. With `provider=whisper` it renders a self-hosted Whisper ASR pod (`onerahmet/openai-whisper-asr-webservice`, reached at its `POST /asr` endpoint) and sets `WHISPER_SERVICE_URL` to its in-cluster Service. With `provider=groq` it flows `GROQ_API_KEY` from a chart-managed voice Secret. ElevenLabs TTS (`ELEVENLABS_API_KEY`, optional `ELEVENLABS_VOICE_ID`) is opt-in and applies to both providers when set. See the `agent.voice` block in `charts/shipwright/values.yaml`.

### Dev-only

**Do not set these in production.**

| Name | Type | Default | Description |
|---|---|---|---|
| `ADMIN_DEV_AUTH` | `bool` | `false` | Enables `GET /admin/dev-login` (bypasses Google OAuth, mints a dev session). Blocked when `NODE_ENV=production`. |
| `METRICS_DASHBOARD_DEV_AUTH` | `bool` | `false` | Bypasses `/dashboard` session auth and `/metrics/*` API auth for local dev. Must not be enabled in production — exits with an error if `NODE_ENV=production`. |
| `TASK_STORE_SEED_ADMIN_TOKEN` | `string` | — | Bootstrap admin token seeded into the task-store on startup. Used only in local dev (`task stack` and `task hitl`) to provision a bootstrapped admin token without manual token creation. Not a real secret — used only against the local dev Postgres instance. Ignored if empty. |
| `CHAT_SEED_ADMIN_TOKEN` | `string` | — | Bootstrap admin token seeded into the chat service on startup. Used only in local dev to provision a bootstrapped admin token without manual token creation. Not a real secret — used only against the local dev Postgres instance. Ignored if empty. |
| `SHIPWRIGHT_HITL_HOME` | `string` | `~/.shipwright` | Root directory for the human-in-the-loop runner workspace (`task hitl`). The workspace contains `repos/`, `worktrees/`, `state/reviews/`, and `.claude/` subdirectories. |
| `SHIPWRIGHT_HITL_HOST` | `string` | `localhost` | Hostname for service URLs in the HITL runner. Used to construct URLs for task-store and admin services (e.g. `http://localhost:3002` for task-store). |
| `SHIPWRIGHT_HITL_REPOS` | `string` | — | Comma-separated list of `org/repo` strings assigned to the HITL agent record. Controls which task-store tasks the HITL agent token can claim via repo-scoped ownership (e.g. `app-vitals/shipwright`). Repos listed here are automatically cloned into `repos/` during HITL preflight (via `gh repo clone`) if not already present, ensuring all configured repos are available for dev-task work without manual cloning. |
| `SHIPWRIGHT_HITL_AUTHORS` | `string` | — | Comma-separated list of GitHub login strings; when set, restricts review candidates to PRs authored by one of these users (default: none, unfiltered). Equivalent to the agent's `authorAllowlist` config field; `hitl.ts` syncs this value onto the persisted hitl agent record via `PATCH /agents/:id`. |
| `SHIPWRIGHT_HITL_POLL_INTERVAL` | `number` | `60` | Polling interval in seconds for the HITL runner's task fetch loop. When no ready tasks are found, the runner waits this many seconds before retrying. |

---

## Observability

Each of `admin`, `metrics`, `task-store`, and `agent` reads its own `SENTRY_DSN` from its own environment — there is no shared/global toggle. See [`docs/observability.md`](./observability.md) for exactly what is (and isn't) collected and how the scrub hooks work.

`SENTRY_DSN` / `SENTRY_ENVIRONMENT` are documented per-service rather than repeated here: see the `SENTRY_DSN` row under [Agent Config → Server](#server) for the agent — including the pod-startup timing constraint, since `initSentry` runs once at module load, before the config sync loop — and the `SENTRY_DSN` row under [Agent Config → Metrics & Admin & Chat & Task-Store services](#metrics--admin--chat--task-store-services) for `task-store`, `metrics`, and `admin`.

This is the write side (services reporting into Sentry). For the read side — the `SENTRY_ORG` / `SENTRY_AUTH_TOKEN` credentials (documented above under [Plugin Config](#plugin-config)) and how the `error-scan`, `error-fix`, and `error-resolve` skills query the Sentry Issues API — see [Read side](./observability.md#read-side) in `docs/observability.md`.

---

## Policy Config

Agent behavior is controlled by `state/agent-policy.md`. This is a Markdown file with a YAML front-matter block, automatically seeded from a template when the workspace is provisioned. Edit it directly to change review posting, merge permissions, and autonomy levels without reconfiguring crons or restarting the agent. `auto_post_reviews` defaults to `true` (reviews post to GitHub automatically) on initial provisioning; set it to `false` to stage reviews locally for owner approval instead.

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `auto_post_reviews` | `bool` | `true` | Post review comments to GitHub automatically without manual approval. Set to `false` to stage reviews locally for owner approval instead. |
| `allowed_events` | `string[]` | `["COMMENT", "APPROVE"]` | GitHub review event types the agent may emit. |
| `review_external_prs` | `bool` | `true` | Currently unused — `/shipwright:review` always targets a single explicit PR (no repo-wide scan to filter), and no other command reads this field. |
| `allow_self_review` | `bool` | `true` | Read by `agent/src/check-review.ts`'s `getReviewCandidates()` (the `shipwright-loop` cron's in-process review candidate provider) to decide whether the agent's own open PRs are review candidates. Set to `false` to require a human reviewer on agent-authored PRs. **Exception (RRR-1.1):** when the agent is explicitly listed as a requested reviewer on a PR (via GitHub's "Request a reviewer" UI), the PR is included even if `allow_self_review=false` — an additive override allowing human-directed self-review. This override does **not** extend to the author allowlist (the `Agent.authorAllowlist` DB field, synced via `agentAuthorAllowlistRef`; local-dev equivalent `SHIPWRIGHT_HITL_AUTHORS`): a PR from an allowlist-excluded author is still excluded regardless of requested-reviewer status, since `reviewRequests` is attacker-controllable by any author with repo write access and would otherwise let an excluded author unilaterally bypass the allowlist. All other filters (draft status, dependabot/automated-label, live-review dedup, task-store dedup, HITL/blocked, bundle-incomplete) also remain unconditionally applied regardless of requested-reviewer status. |
| `min_confidence` | `number` | `75` | Minimum confidence score (0–100) for a finding to be included in a review. |
| `max_findings` | `number` | `5` | Maximum number of findings to include in a single review. |
| `cleanup_merged_worktrees` | `bool` | `true` | Read by the agent's background worktree reconciler to decide whether merged-PR worktrees are automatically removed (`agent/src/pr-state-reconciler.ts`'s `reconcileRecord()`). Not read by `/shipwright:review`. |
| `cleanup_after_days` | `number` | `14` | Age threshold (days) before a worktree is eligible for automatic cleanup via `reconcileStaleWorktrees()` (`agent/src/worktree-reaper.ts`, run on the same background interval as `agent/src/pr-state-reconciler.ts`). Not read by `/shipwright:review`. |

### Example

```markdown
---
auto_post_reviews: true
allowed_events: [COMMENT, APPROVE]
allow_self_review: true
min_confidence: 75
max_findings: 5
cleanup_merged_worktrees: true
cleanup_after_days: 14
---
```

(`review_external_prs` is omitted above — see the table row: currently unused.)

---

## See also

- [architecture.md](./architecture.md) — the four-artifact A→B→C→D design.
- [agent.md](./agent.md) — Shipwright agent runtime, admin CRUD APIs, and data model.
- [quickstart.md](./quickstart.md) — how to get the full dev stack running locally.
- `CLAUDE.md` — env var namespacing convention and database env var rules.
