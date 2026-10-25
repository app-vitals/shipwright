# Agent Web UI

> Coding half. The platform half is the vendored snapshot [`docs/platform/agent-web-ui.md`](./platform/agent-web-ui.md), sourced from `app-vitals/agent`.

> The Shipwright agent's browser-facing surfaces — split out of
> [`docs/agent.md`](./agent.md) to keep that file under the docs size-governance
> threshold. Covers the admin chat UI, sessions list UI, session alert sweeper,
> public read-only task board, dev auto-login, PWA shell, and local-agent chat.
> See [`docs/agent.md`](./agent.md) for run modes, the runtime/admin CRUD APIs,
> and the Prisma data model.

---

## Sessions list UI (`admin-ui-sessions-list.ts`) — authenticated

Mounted at `/admin/sessions*`. **Requires authentication** — session cookie or bearer token (same auth as admin CRUD API). Renders a paginated list of sessions grouped by state (Waiting on you / Active / Closed), with query-based filtering and member-scoped visibility. Admins see all sessions; non-admin members see only sessions with a task assigned to one of their agents or in one of those agents' repositories. When task-store access is unavailable, the page renders in degraded mode (empty sections + warning banner). Each row shows a single merged Session column — the title (falling back to the slug when untitled), with the slug shown underneath in small muted mono text only when it differs from the title — and resolves each session's `agentIds` to agent names (`agentService.listByIds`, raw id fallback when unmatched). Waiting since / Last activity timestamps render in the configured `timezone` (SPT-1.2, defaults to `America/Los_Angeles`, same pattern as every other admin page). Each row also displays a Follow button (wired to `SessionFollowService` via delegated click handler, FLW-1.1) showing "Follow" or "Following" based on the caller's follow state; clicking posts to the `/admin/sessions/:slug/follow` or `/admin/sessions/:slug/unfollow` endpoint.

| Method | Path | Auth | Description |
|---|---|---|---|

**Visibility scoping (SESH-4.1, SSP-6.8):** The sessions list and detail routes use the same visibility logic, now including account-level scoping (SSP-6.8). Scope resolution order: **Platform admins** (`isAdmin=true`) see all sessions across all accounts; `?accountId=` narrows to one account. **Account users** (self-serve flag on, via `callerScopeResolver`) see only their own account's sessions (no agent/repo overlap required — account membership alone grants access). **Agent members** (non-admin, non-account-user) see only sessions with tasks assigned/claimed by their agents, or in their agents' repositories, within any account containing such agents. A member with zero `AgentMember` rows and no account membership sees an empty sessions list and receives `404` for any detail route. The visibility scope is computed once per request via `resolveVisibilityScope()` (in `admin-ui-sessions-list.ts`) and applied identically to both list and detail routes. The list route passes the resolved scope (including `accountId` for account users, or no account restriction for admins) to the task-store's `GET /sessions` call; the detail route derives the equivalent shape from the session's tasks via `deriveSessionVisibilityFromTasks()` (in `session-scope.ts`), which uses the same `claimedBy ?? assignee` precedence as `task-store/src/session-rollup.ts` — so a reassigned task's former assignee loses detail access at the same moment the session disappears from their list. For platform admins, the sessions list includes an Account column showing each session's `accountId`; account users and agent members see only their scope's sessions and no account column.

**Degraded mode:** When the task-store service is unavailable or `fetchTaskStoreSessions` is not configured, the sessions list page renders empty sections with a warning banner. The detail route behaves the same way — with no tasks fetched, the member scope check is skipped (it could only ever deny) and the page renders `200` with an empty task list plus the warning banner, rather than `404`ing members during a transient outage. The routes remain accessible and return `200` — callers are not redirected or rejected.

**Configuration:**

- Task-store connection is inherited from the agent's main config (`SHIPWRIGHT_TASK_STORE_URL` and `SHIPWRIGHT_TASK_STORE_TOKEN`). No additional env vars required for this route.

## Session alert sweeper (`session-alert-sweeper.ts`) — background job

`SessionAlertSweeper` is one of the admin service's background loops (SESH-7.4); alongside per-agent `trial-expiry-sweeper.ts` and `trial-expiry-warning-sweeper.ts` (for cron lockdown and pre-expiry warnings), plus account-level `account-trial-expiry-sweeper.ts` and `account-trial-warning-sweeper.ts`, it is registered as a background pass via the coding `AdminExtension`'s `backgroundPasses` hook during admin boot (in `admin/src/admin-boot.ts`), never inside route handlers like `createAdminUIApp()` which must stay side-effect-free. The other four have no browser-facing surface of their own; see [`agent-key-files.md`](./agent-key-files.md) for their per-file detail. `SessionAlertSweeper` itself, every tick:

1. Fetches the task-store's `waiting` and `closed` sessions (`GET /sessions?state=waiting`/`?state=closed`, admin token, `limit=500`).
2. Materializes auto-follows: for each user with `UserNotificationPrefs.autoFollowSessions = true` who can already see a waiting session, has no existing `SessionFollow` row, and whose auto-follow boundary (`autoFollowSince`, else the prefs row's `createdAt`) predates the session, upserts a `SessionFollow` row.
3. Sends one `immediate` push the first time a follower is alerted about a waiting session, and at most one `reminder` per later local day once that user's `reminderHourLocal` has passed — derived entirely from `SessionAlertState.lastAlertedAt` (the schema stores no "kind" column).
4. Sends one `completed` push per follower of a closed session, then deletes that pair's `SessionFollow` + `SessionAlertState` rows so it never fires again.
5. Prunes the `SessionAlertState` row of any follower who has lost visibility of the session (membership revoked / repo removed), sending them nothing.

Pushes reuse `PushService.notifySession()` — the same Web Push delivery path as the chat-reply notifier (`POST /admin/push/notify`) — so they share the same VAPID configuration and the same `SHIPWRIGHT_ADMIN_PUSH_MAX_DETAIL` operator ceiling. Not re-entrant: an in-flight guard makes an overlapping tick (a slow task-store fetch under a short interval) return an all-zero result rather than racing the sweep already running; this guard is per-process, so running more than one admin replica needs a shared lock not introduced by this task.

See [`docs/session-notifications.md`](./session-notifications.md) for the follow/mute data model, the per-user notification-detail policy, and the `session-scope.ts` visibility model this sweeper enforces when pruning followers.

**Configuration:**

- The sweeper only starts when Web Push is fully configured (`SHIPWRIGHT_ADMIN_VAPID_PUBLIC_KEY` + `SHIPWRIGHT_ADMIN_VAPID_PRIVATE_KEY` + `SHIPWRIGHT_ADMIN_VAPID_SUBJECT`) **and** `SHIPWRIGHT_TASK_STORE_URL` + `SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN` are set — otherwise it is never registered (not degraded-mode; simply absent).
- `SHIPWRIGHT_ADMIN_SESSION_ALERT_INTERVAL_MS` (optional, default `60000`) — tick cadence in ms. Blank, non-numeric, zero, or negative values fall back to the default.
- See [`configuration-agent.md`](./configuration-agent.md#metrics--admin--chat--task-store-services) for the full env var reference.

## Public read-only task board (`coding/admin-ui-coding.ts`) — unauthenticated

Mounted at `/public/tasks`. **No authentication required** — renders a read-only task list scoped to a configurable repository. When `SHIPWRIGHT_ADMIN_PUBLIC_REPO` is set, fetches tasks for that repo from the task-store and displays them in a static HTML page with no mutation controls (create/edit/status-change disabled). When the config is absent or task-store access fails, the page renders in degraded mode (empty table + warning notice). The endpoint is always registered and always accessible; it gracefully degrades when prerequisites are missing.

| Method | Path | Auth | Description |
|---|---|---|---|

**Configuration:**

- `SHIPWRIGHT_ADMIN_PUBLIC_REPO` (optional) — repository slug (format: `org/repo`) scoped for the public board. When set, the board queries and displays tasks for this repo only. When unset, the board renders in degraded mode.

## Chatting with a local agent

There is no HTTP chat endpoint on the agent. Chat flows through the chat service: the admin console's Chat tab (`/admin/chat`) posts user messages to the chat service, and the agent's chat poll loop (`chat-poller.ts`) claims them, runs them through Claude, and posts replies. `task stack` wires all of this up locally, including seeded dev tokens.
