# Shipwright Agent — Operations

> Tool authorization/narrowing, default system crons, environment configuration, and baked marketplaces for the Shipwright agent (artifact **C**). See [agent.md](./agent.md) for the agent's architecture, HTTP surfaces, and data model.

## Tool management and narrowing

The agent runtime implements a two-tier tool authorization system to narrowly grant Claude access to tools: **floor tools** (unconditional, always present) and **allowed tools** (DB-driven, configurable per agent).

### Floor tools

When the agent spawns a Claude session, it always includes a fixed set of 7 **floor tools** (`FLOOR_TOOLS` constant in `agent/src/claude.ts`):

- `Read` — read-only file access (safe, no side effects)
- `Write` — create new files (safe, limited blast radius)
- `Edit` — modify existing file content (safe, scoped)
- `Glob` — pattern-based file discovery (safe, read-only)
- `Grep` — content search (safe, read-only)
- `Skill` — invoke built-in skills (safe by design; does not grant additional system access)
- `TodoWrite` — legacy task-tracking tool (safe, limited scope)

These tools are **non-revocable** — they are not derivable from the `AgentTool` database table and are always granted, regardless of agent configuration. They have no meaningful security delta from `Read` (which is the assumed safe baseline) and enable essential read-only operations without privileging escalation.

**Crucially**, `Bash`, `WebSearch`, `WebFetch`, and `Agent` are **not** in the floor set. These are high-privilege tools (arbitrary system execution, external HTTP, sub-agent spawning) and must be explicitly seeded into the agent's `AgentTool` table to be available. An agent with no `AgentTool` rows (or a 404'd config bundle from the admin API) receives only the 7 floor tools and cannot execute shell commands, fetch external URLs, or dispatch sub-agents.

### Configurable allowed tools (`AgentTool` table)

Tools beyond the floor set are configured via the `AgentTool` database table (one row per tool pattern per agent). When `POST /agents` creates a new agent, it seeds `AgentTool` rows (including high-privilege tools like Bash, WebSearch, WebFetch, Agent) from the resolved Agent Type manifest's `tools[]` (see `agent-types/coding/manifest.yaml` for the default "coding" type). Operators and integrations can then toggle individual tools on/off via the admin UI or the `/agents/:id/tools` CRUD API.

The agent's config sync loop (every 60 seconds) fetches the agent's full tool list from `/agents/:id/config`, decrypts it, and merges with the floor tools. Deduplication preserves insertion order (floor-tools-first, then extra-allowed-tools), so floor tools always take precedence in the final list.

**Tool changes flow:**
1. Operator/integration updates AgentTool rows via the admin API (`POST`/`PATCH`/`DELETE /agents/:id/tools/:toolId`)
2. Agent's 60-second config sync fetches updated `allowedTools` from `/agents/:id/config`
3. Next Claude session (up to 1 minute later) sees the new tool list — no pod restart required

### Example: narrowing an agent to read-only mode

To disable shell access and external requests for a risky agent, note that the `:toolId` path
param on the tools routes is the `AgentTool` row's cuid **primary key**, not the tool's `pattern`
string — so you first need to look up the row ids:

1. Call `GET /agents/:id/tools` (via admin API) and find the rows whose `pattern` is `"Bash"`,
   `"WebSearch"`, and `"WebFetch"`, noting each row's `id`.
2. Call `DELETE /agents/:id/tools/:toolId` for the `Bash` row's `id`.
3. Call `DELETE /agents/:id/tools/:toolId` for the `WebSearch` row's `id`.
4. Call `DELETE /agents/:id/tools/:toolId` for the `WebFetch` row's `id`.

On the agent's next config sync, Claude will no longer have access to shell execution or external HTTP — only the 7 floor tools remain. The agent can still read files, search locally, and invoke safe skills.

## Default system crons

Every new agent is seeded with the system crons declared by its **agent type manifest** — the source of truth is [`agent-types/{typeName}/manifest.yaml`](../agent-types/coding/manifest.yaml)'s `crons` array (e.g. the `coding` type's thirteen crons). The agent's stored `typeName` is resolved to its manifest at reconcile time via the `AgentTypeRegistry` ([`admin/src/agent-type-manifest-loader.ts`](../admin/src/agent-type-manifest-loader.ts)); an unknown `typeName` falls back to the `coding` manifest with a logged warning, so the boot path never fails. The manifest is reconciled onto each agent at startup via `POST /agents/:id/crons/reconcile`. Reconciliation uses a two-pass strategy: Pass 1 creates or updates each system cron entry (preserving existing IDs for FK stability), recording each into a name → id map. Pass 2 resolves parent/child links by looking up parent cron names in the map and setting `parentCronId` on declared child crons, clearing any existing `parentCronId` back to `null` when an entry no longer declares a resolvable `parentCron` — self-healing the link on every agent boot in both directions with no manual migration. Three are **enabled by default** (`shipwright-dev-task`, `shipwright-review`, `shipwright-patch`); the rest are opt-in (toggle in the admin UI). System crons cannot be modified via the API — they are read-only after creation and are kept in sync with the manifest's cron definitions via the reconciliation process. All run `silent` (they post to Slack only on a result worth surfacing, or on error). Some carry a `preCheck` script whose stdout becomes the actual prompt, so a cron only spends a Claude turn when there is real work ready.

The four pipeline crons (`shipwright-dev-task`, `shipwright-review`, `shipwright-patch`,
`shipwright-deploy`) are **loop-driven, item-addressed executors, not self-discovering
standalone crons.** They are linked as child crons of `shipwright-loop` (via `parentCronId`),
which is the sole supported driver for these four phases: its in-process candidate providers
(`agent/src/check-dev-task.ts`, `check-review.ts`, `check-patch.ts`, `check-deploy.ts`) select
a winning candidate each tick and `loop-orchestrator.ts` dispatches the matching command with an
explicit task id or `org/repo#number` embedded in the prompt. None of the four commands scans
for its own work — each responds `[silent]` and exits immediately if invoked with no target.
This means a standalone pipeline cron (`shipwright-loop` disabled) is **silently inert**: its
stored prompt (e.g. `/shipwright:dev-task`) carries no target, so every tick dispatches, goes
`[silent]`, and does nothing. See [migration.md](./migration.md) for the breaking-change
note and the fix (enable `shipwright-loop`).

| Cron | Schedule (cron expr) | Default | What it does |
|---|---|---|---|
| `shipwright-dev-task` | `* * * * *` (every minute) | **on** | Builds and ships a PR for the task `shipwright-loop` selects (dispatched with an explicit task id). Standalone (loop disabled): inert — see above. |
| `shipwright-review` | `* * * * *` (every minute) | **on** | Reviews the PR `shipwright-loop` selects (dispatched with an explicit `org/repo#number`). Standalone (loop disabled): inert — see above. |
| `shipwright-patch` | `* * * * *` (every minute) | **on** | Patches the PR `shipwright-loop` selects (dispatched with an explicit `org/repo#number`). Standalone (loop disabled): inert — see above. |
| `shipwright-deploy` | `* * * * *` (every minute) | off | Merges and deploys the PR `shipwright-loop` selects (dispatched with an explicit `org/repo#number`). Standalone (loop disabled): inert — see above. |
| `shipwright-loop` | `* * * * *` (every minute) | off | Internal: dispatches enabled pipeline phases (dev-task, review, patch, deploy) in a single multi-step drain-until-dry run. Orchestrates phase toggling and claim/retry logic; requires explicit enablement alongside per-phase cron toggling. Implemented by the `loop-orchestrator.ts` module — drain-until-dry through all phases on every tick, strict age-based FIFO work selection, per-dispatch run reporting, spin detection (warns via `console.warn` when the same item is dispatched 3+ times consecutively, signaling a potential infinite loop for Sentry alerting), busy-stall escalation (LPF-7.2: when a prior tick has been draining for >35 minutes — well past the 30-minute runner() timeout ceiling — it's wedged somewhere before dispatch and cannot self-recover, so escalates to `console.error` instead of routine `console.warn` for Sentry visibility), and skip tracking (SKT-2.1): when a dispatch returns a `[silent]` marker (found nothing to do), records a skip via the task store; when `skipCount` crosses threshold (3), the task store auto-blocks the item with `hitl=true` to halt further re-dispatches without human review. **Skip-reason exemptions (STD-1.1):** skip reasons following the `{command}:{category}:{reason}[:{detail}]` taxonomy with a `deferred` category segment bypass skip counting, preventing false auto-blocks when work is deferred to a legitimate concurrent sibling, a PR is deferred due to unresolved human feedback (STD-1.4: `review:deferred:unresolved-human-feedback:*`), or work is otherwise awaiting completion of a dependency; the taxonomy-conformant `dev-task:deferred:same-branch-sibling-busy:` marker is already covered by this generic check (its second segment is `deferred`); for backward compatibility with an agent whose plugin install lags the deployed `agent/` binary, skip reasons starting with the OLD pre-rename marker `dev-task:same-branch-sibling-busy:` (no `deferred` segment) are also exempted via an explicit prefix check. A `[silent]`-marker dispatch also reports its `AgentCronRun.skipReason` from the dispatched command's own `[skip-reason:text]` marker when present (DBV-1.1) — e.g. deploy's Step 2b bundle-completeness gate emits `[skip-reason:deploy:deferred:bundle-incomplete:{HEAD_BRANCH}]` alongside `[silent]` so the skipped run's reason is visible in the admin cron-logs UI instead of the generic `command:no-work` fallback used when no command-specific reason is tagged; see `agent/src/markers.ts`. |
| `shipwright-test-readiness` | `0 6 * * *` (daily, 06:00) | off | Iterates repos in `repos/` with a `docs/test-readiness/` directory and runs the full test-readiness audit (`--full --publish`) once per qualifying repo, each in its own worktree + branch. Via the `check-test-readiness.ts` preCheck, only repos with stale or missing phase artifacts are invoked. |
| `shipwright-docs-freshness` | `0 7 * * *` (daily, 07:00) | off | Scans all repos in `repos/` for source changes and refreshes docs that drifted from the code via the docs-freshness agent (`research-docs --auto`). Iterates per-repo, checking each against its `state/docs-last-synced.json` anchor — skips repos without `docs/` directories. After updating stale docs, runs a quality pass (RDQ-1.2) that detects canonical-source duplication, literal/prose mismatches, and mechanism-honesty gaps, filing tasks for each issue found. |
| `learn-dream` | `0 3 * * *` (daily, 03:00) | off | Mines the last day of merged PRs for durable learnings. |
| `entropy-patrol-maintenance` | `0 4 * * 1` (weekly, Mon 04:00) | off | Scans for code entropy and fixes what's PR-worthy. |
| `error-patrol-maintenance` | `0 4 * * *` (daily, 04:00) | off | Scans for unresolved Sentry errors and fixes what's PR-worthy. |
| `security-patrol-maintenance` | `0 6 * * 1` (weekly, Mon 06:00) | off | Scans for security vulnerabilities and fixes what's PR-worthy. |
| `consolidation-patrol-maintenance` | `0 5 * * 1` (weekly, Mon 05:00) | off | Scans for emerging duplicate/similar code patterns that have stabilized across multiple runs and proposes consolidation for what's ready. Recommended to stay disabled after merge until `state/consolidation-ledger.json` has accumulated a few weeks of real signal. |

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL_SHIPWRIGHT_ADMIN` | ✅ | Dedicated Postgres datasource for the admin service (e.g. `postgresql://user:pass@host:5432/db`). |
| `SHIPWRIGHT_AGENT_ID` | ✅ (entrypoint) | The agent's ID in the Shipwright platform. Also settable via `--agent-id` CLI flag. |
| `SHIPWRIGHT_API_URL` | ✅ (entrypoint) | Base URL of the Shipwright API used to fetch agent config at startup. Also settable via `--api-url`. |
| `SHIPWRIGHT_AGENT_API_KEY` | ✅ (entrypoint) | Bearer token for the config fetch at startup (`/agents/:id/config` and `/agents/:id/crons`). Also settable via `--api-key`. The value must be registered in `SHIPWRIGHT_ADMIN_API_KEYS` on the server with scope `<agentId>` (or `*` for admin bypass) — an agent key not listed there will receive a 401 at startup. |
| `AGENT_HOME` | entrypoint | Persistent storage root (default: `/data/agent-home`). Mount a PVC here in Kubernetes so mise caches, workspace files, and `~/.claude` survive pod restarts. |
| `PORT` | server | Port for the admin service (`admin/src/main.ts`). Default: `3000`. |
| `SHIPWRIGHT_HEALTH_PORT` | server | Dedicated health server port for K8s liveness probes (default: `3459`). Started in-process by `entrypoint-main.ts` before startup. |
| `SHIPWRIGHT_SESSION_SECRET` | admin API | Secret for verifying the `admin_session` JWT cookie. |
| `SHIPWRIGHT_ADMIN_API_KEYS` | admin API | Comma-separated `name:token:scope` tuples for env-based bearer auth on `/agents/*`. Scope `*` → admin (bypasses per-agent checks); scope `<agentId>` → restricted to that agent's routes. Optional — absent means env key auth is disabled and only DB tokens and session cookies are accepted. Example: `bodhi:sk_bodhi_abc:*,svc:sk_svc_xyz:agent-id-123`. |
| `GOOGLE_CLIENT_ID` | admin UI (OAuth) | Google OAuth 2.0 client ID. Required for the admin login flow (optional when using Okta). |
| `GOOGLE_CLIENT_SECRET` | admin UI (OAuth) | Google OAuth 2.0 client secret. Required for the admin login flow (optional when using Okta). |
| `OKTA_ISSUER` | admin UI (OIDC) | Okta OIDC issuer URL (e.g. `https://your-org.okta.com/oauth2/default`). Required to enable the `/admin/auth/okta` login flow — when unset, those routes redirect to the login page with `error=server_error` and Google login is unaffected. |
| `OKTA_CLIENT_ID` | admin UI (OIDC) | Okta OIDC client ID. Required for the admin UI Okta login flow. |
| `OKTA_CLIENT_SECRET` | admin UI (OIDC) | Okta OIDC client secret. Required for the admin UI Okta login flow. |
| `SHIPWRIGHT_ADMIN_ALLOWED_EMAILS` | admin UI (OAuth/OIDC) | Comma-separated list of email addresses permitted to log in to the admin UI via either Google OAuth or Okta OIDC. |
| `SHIPWRIGHT_ADMIN_APP_BASE_URL` | admin UI (OAuth/OIDC) | Public base URL of the server (e.g. `https://shipwright.example.com`). Used to construct the OAuth/OIDC redirect URIs for both providers. An explicit value always wins. When empty and deployed via Helm, auto-derives from the ingress/gateway host when `networking.type=ingress` or `networking.type=gateway` (with HTTPS when TLS is on); omitted for ClusterIP/NodePort/LoadBalancer unless set explicitly. Defaults to `http://localhost:{PORT}` in bare-metal deployment. |
| `SHIPWRIGHT_ENCRYPTION_KEY` | secrets at rest | 64-char hex (32 bytes) for AES-256-GCM. **If unset, secrets are stored in plain text** (logged warning) — set it in any real deployment. |
| `GH_APP_ID` | GitHub App auth | GitHub App ID (integer as string). Required when using the App auth path. |
| `GH_APP_PRIVATE_KEY` | GitHub App auth | PEM private key for the GitHub App (newlines may be `\n`-escaped). Required when using the App auth path. |
| `GH_APP_INSTALLATION_ID` | GitHub App auth | Installation ID for the target org/repo. Required when using the App auth path. |
| `GH_APP_CLIENT_ID` | GitHub App auth | OAuth client ID for the GitHub App, persisted from the manifest-flow exchange so the App's OAuth settings can be reconfigured later without redoing the manifest flow. |
| `GH_APP_CLIENT_SECRET` | GitHub App auth | OAuth client secret for the GitHub App, persisted from the manifest-flow exchange. |
| `GH_TOKEN` | GitHub PAT auth | Personal Access Token for the legacy `gh auth setup-git` path. Used only if the App env vars are absent. |
| `ADMIN_DEV_AUTH` | dev only | Set to `"true"` to enable `GET /admin/dev-login` (bypasses OAuth/OIDC provider login, mints a dev session). Hard-blocked when `NODE_ENV=production` by `dev-auth-guard.ts`. |

## Baked marketplaces (derived images)

A derived Docker image can ship additional Claude Code plugin marketplaces that are automatically registered at agent boot — no env var, no DB entry required. Marketplace availability is an **image property**; plugin selection remains in the AgentPlugin table as usual.

**Convention root:** `/opt/shipwright/marketplaces/`

Place one subdirectory per marketplace under the convention root. Each subdirectory must contain `.claude-plugin/marketplace.json` (the standard marketplace manifest). The harness calls `claude plugin marketplace add <dir>` for every discovered directory **before** registering the built-in shipwright marketplace, so derived-image plugins resolve correctly.

```
/opt/shipwright/marketplaces/
  my-org-plugins/
    .claude-plugin/
      marketplace.json   ← required; triggers discovery
      plugin.json        ← optional plugin metadata
    plugins/
      ...
```

Directories that do not contain `.claude-plugin/marketplace.json` are silently skipped. The registration call is idempotent and non-fatal — a missing directory or a non-zero exit from `claude` is logged as a warning and startup continues.

The constant `BAKED_MARKETPLACES_ROOT` and function `discoverBakedMarketplaces()` in `agent/src/setup.ts` implement this behavior.
