export interface ConfigVar {
  name: string;
  type: string;
  def: string;
  desc: string;
}

export const pluginEnvVars: ConfigVar[] = [
  { name: "JIRA_BASE_URL", type: "string", def: "—", desc: "Base URL of the Jira instance (e.g. https://example.atlassian.net). Required when using the Jira backend." },
  { name: "JIRA_PROJECT_KEY", type: "string", def: "—", desc: "Jira project key (e.g. SHIP). Required when using the Jira backend." },
  { name: "SHIPWRIGHT_REPOS_DIR", type: "string", def: "<AGENT_HOME>/workspace/repos", desc: "Override the workspace repos directory." },
  { name: "SHIPWRIGHT_WORKTREE_DIR", type: "string", def: "<AGENT_HOME>/workspace/worktrees", desc: "Override the workspace worktrees directory." },
  { name: "SHIPWRIGHT_DEV_CHAT", type: "bool", def: "false", desc: "Enables the unauthenticated POST /chat endpoint. Must not be set in production." },
  { name: "GH_CMD", type: "string", def: "gh", desc: "Override the gh CLI executable. Useful in environments where gh is installed to a non-default path." },
  { name: "AGENT_HOME", type: "string", def: "~/.shipwright-agent", desc: "Persistent storage root for workspace files, mise caches, and ~/.claude." },
  { name: "WORKSPACE_PATH", type: "string", def: "—", desc: "Direct workspace path override. Takes precedence over AGENT_HOME-based discovery when set." },
  { name: "JIRA_API_TOKEN", type: "string", def: "—", desc: "API token for Jira authentication. Required when using the Jira backend. Env-var-only (secret)." },
  { name: "JIRA_EMAIL", type: "string", def: "—", desc: "Email address for Jira authentication. Required when using the Jira backend." },
];

export const agentClaudeVars: ConfigVar[] = [
  { name: "ANTHROPIC_MODEL", type: "string", def: "claude-sonnet-4-6", desc: "Claude model used for each agent invocation." },
  { name: "ANTHROPIC_FALLBACK_MODEL", type: "string", def: "—", desc: "Fallback model if the primary is unavailable." },
  { name: "ANTHROPIC_EFFORT_LEVEL", type: "string", def: "—", desc: "Effort/thinking level passed to Claude (e.g. extended, auto, none)." },
  { name: "ANTHROPIC_API_KEY", type: "string", def: "—", desc: "Anthropic API key. Env-var-only (secret)." },
  { name: "CLAUDE_CODE_OAUTH_TOKEN", type: "string", def: "—", desc: "Claude Code OAuth token (alternative to ANTHROPIC_API_KEY). Env-var-only (secret)." },
];

export const agentSlackVars: ConfigVar[] = [
  { name: "SLACK_BOT_TOKEN", type: "string", def: "required for Slack", desc: "Slack bot user OAuth token (xoxb-...)." },
  { name: "SLACK_APP_TOKEN", type: "string", def: "required for Slack", desc: "Slack app-level token for Socket Mode (xapp-...)." },
  { name: "SLACK_SIGNING_SECRET", type: "string", def: "required for Slack", desc: "Used to verify incoming Slack request signatures." },
  { name: "SLACK_ADMIN_TOKEN", type: "string", def: "—", desc: "Optional admin-level token for privileged Slack operations." },
  { name: "SLACK_ALERT_CHANNEL", type: "string", def: "—", desc: "Slack channel ID to post system alerts (e.g. startup errors)." },
  { name: "SLACK_OWNER_USER", type: "string", def: "—", desc: "Slack user ID of the agent owner, used for DM fallback." },
];

export const agentGithubVars: ConfigVar[] = [
  { name: "GH_APP_ID", type: "string", def: "required for App auth", desc: "GitHub App ID (integer as string). Env-var-only (secret)." },
  { name: "GH_APP_INSTALLATION_ID", type: "string", def: "required for App auth", desc: "Installation ID for the target org/repo. Env-var-only (secret)." },
  { name: "GH_APP_PRIVATE_KEY", type: "string", def: "required for App auth", desc: "PEM private key for the GitHub App. Env-var-only (secret)." },
  { name: "GH_TOKEN", type: "string", def: "—", desc: "Personal Access Token. Used only when GitHub App vars are absent. Env-var-only (secret)." },
];

export const agentPlatformVars: ConfigVar[] = [
  { name: "SHIPWRIGHT_API_URL", type: "string", def: "—", desc: "Base URL of the Shipwright admin service, used by the agent entrypoint to fetch config at startup." },
  { name: "SHIPWRIGHT_AGENT_ID", type: "string", def: "—", desc: "The agent's ID in the Shipwright platform. Also settable via --agent-id CLI flag." },
  { name: "SHIPWRIGHT_AGENT_API_KEY", type: "string", def: "—", desc: "Bearer token for the config fetch at startup (/agents/:id/config and /agents/:id/crons). Also settable via --api-key CLI flag." },
];

export const agentServerVars: ConfigVar[] = [
  { name: "PORT", type: "number", def: "3000", desc: "Dev-only chat server port (SHIPWRIGHT_DEV_CHAT gate, DEFAULT-DENY). Not used in production." },
  { name: "SHIPWRIGHT_HEALTH_PORT", type: "number", def: "3459", desc: "Agent health server port for the K8s liveness probe. Served in-process by entrypoint-main.ts on a dedicated port separate from the chat server." },
  { name: "NODE_ENV", type: "string", def: "—", desc: "Runtime environment. Set to production to enforce production-safety guards." },
];

export const agentMetricsVars: ConfigVar[] = [
  { name: "DATABASE_URL_SHIPWRIGHT_ADMIN", type: "string", def: "required", desc: "Postgres connection string for the admin service schema." },
  { name: "SHIPWRIGHT_SESSION_SECRET", type: "string", def: "—", desc: "HS256 secret for signing session cookies. Used by the metrics service (vitals_session cookie) and the admin service (admin_session cookie)." },
  { name: "SHIPWRIGHT_ENCRYPTION_KEY", type: "string", def: "—", desc: "64-char hex (32 bytes) for AES-256-GCM encryption of secrets at rest. If unset, secrets are stored in plain text." },
  { name: "SHIPWRIGHT_ADMIN_ALLOWED_EMAILS", type: "string", def: "—", desc: "Comma-separated list of Google email addresses permitted to log in to the admin UI." },
  { name: "SHIPWRIGHT_ADMIN_APP_BASE_URL", type: "string", def: "http://localhost:{PORT}", desc: "Public base URL of the admin service, used to construct the Google OAuth redirect URI." },
  { name: "GOOGLE_CLIENT_ID", type: "string", def: "—", desc: "Google OAuth 2.0 client ID. Required for the admin UI login flow." },
  { name: "GOOGLE_CLIENT_SECRET", type: "string", def: "—", desc: "Google OAuth 2.0 client secret. Required for the admin UI login flow." },
];

export const agentWorkspaceVars: ConfigVar[] = [
  { name: "AGENT_HOME", type: "string", def: "/data/agent-home", desc: "Persistent storage root. Mount a PVC here in Kubernetes so mise caches, workspace files, and ~/.claude survive pod restarts." },
  { name: "MISE_DATA_DIR", type: "string", def: "<AGENT_HOME>/mise", desc: "Override the mise data directory. Auto-derived from AGENT_HOME." },
  { name: "MISE_CACHE_DIR", type: "string", def: "<AGENT_HOME>/mise/cache", desc: "Override the mise cache directory." },
  { name: "XDG_CACHE_HOME", type: "string", def: "<AGENT_HOME>/cache", desc: "Override the XDG cache directory." },
  { name: "XDG_DATA_HOME", type: "string", def: "$HOME/.local/share", desc: "Override the XDG data directory. Used to locate the mise data dir ($XDG_DATA_HOME/mise) when seeding a fresh PVC." },
  { name: "SHIPWRIGHT_STARTUP_TIMEOUT_MS", type: "number", def: "180000", desc: "Maximum milliseconds the entrypoint startup sequence may take before the agent exits. Override to a lower value (e.g. 10000) in dev for faster fail-fast feedback." },
  { name: "AGENT_ALLOWED_TOOLS", type: "string (JSON array)", def: "—", desc: "JSON array of allowed Claude tool patterns. Set by the admin service config sync; do not set manually in production." },
];

export const agentVoiceVars: ConfigVar[] = [
  { name: "GROQ_API_KEY", type: "string", def: "—", desc: "Groq API key for voice processing. Env-var-only (secret)." },
  { name: "ELEVENLABS_API_KEY", type: "string", def: "—", desc: "ElevenLabs API key for speech synthesis. Env-var-only (secret)." },
  { name: "ELEVENLABS_VOICE_ID", type: "string", def: "—", desc: "ElevenLabs voice ID to use for synthesis." },
  { name: "WHISPER_SERVICE_URL", type: "string", def: "—", desc: "URL of a Whisper transcription service for voice input." },
];

export const agentDevVars: ConfigVar[] = [
  { name: "SHIPWRIGHT_DEV_CHAT", type: "bool", def: "false", desc: "Enables the unauthenticated POST /chat endpoint. Blocked at startup when NODE_ENV=production." },
  { name: "ADMIN_DEV_AUTH", type: "bool", def: "false", desc: "Enables GET /admin/dev-login (bypasses Google OAuth, mints a dev session). Blocked when NODE_ENV=production." },
  { name: "METRICS_DASHBOARD_DEV_AUTH", type: "bool", def: "false", desc: "Bypasses /dashboard session auth and /metrics/* API auth for local dev. Must not be enabled in production — exits with an error if NODE_ENV=production." },
  { name: "TASK_STORE_SEED_ADMIN_TOKEN", type: "string", def: "—", desc: "Bootstrap admin token seeded into the task-store on startup. Used only in local dev (task stack) to provision a bootstrapped admin token without manual token creation. Ignored if empty." },
];

export const agentTaskStoreVars: ConfigVar[] = [
  { name: "DATABASE_URL_SHIPWRIGHT_TASK_STORE", type: "string", def: "required", desc: "Postgres connection string for the task-store service. Must be a separate database from the admin service — the schema forbids sharing. Read by @shipwright/task-store and @shipwright/agent." },
  { name: "SHIPWRIGHT_TASK_STORE_URL", type: "string", def: "—", desc: "Base URL of the Shipwright task-store service (e.g. http://task-store:3000 or https://tasks.example.com). When set alongside SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN, the admin service wires per-agent tokens during provisioning and injects the URL + token into agent Deployment env vars. Agents use these to authenticate with the task-store API when claiming tasks or updating status." },
  { name: "SHIPWRIGHT_TASK_STORE_TOKEN", type: "string", def: "—", desc: "Bearer token for task-store API access. Minted per-agent by the admin provisioner and stored in the agent Secret; injected into the agent Deployment via SHIPWRIGHT_TASK_STORE_TOKEN env var. Used by agents to claim tasks, update status, and query the task queue. Env-var-only (secret)." },
  { name: "SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN", type: "string", def: "—", desc: "Bearer token for admin-side task-store token minting. Required (alongside SHIPWRIGHT_TASK_STORE_URL) to enable per-agent provisioning on POST /agents. Env-var-only (secret)." },
  { name: "SHIPWRIGHT_TASK_STORE_PUBLIC_URL", type: "string", def: "—", desc: "Externally-reachable base URL of the task-store advertised in the admin mint-token success page. Set this to the public route a local/laptop agent can resolve. When unset, the env block falls back to SHIPWRIGHT_TASK_STORE_URL." },
  { name: "SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS", type: "number", def: "300000", desc: "Milliseconds an agent's task claim remains valid without a heartbeat. When an agent's last heartbeat exceeds this TTL, the claim will be abandoned and the task eligible for re-claiming by another agent." },
  { name: "SHIPWRIGHT_TASK_STORE_DOC_TTL_SECONDS", type: "number", def: "3600", desc: "Time-to-live, in seconds, for ephemeral HTML documents stored via POST /docs and served from GET /docs/:id. After this window the document is evicted and the GET returns 404. Storage is in-memory and process-local." },
  { name: "SHIPWRIGHT_TASK_STORE_AGENTS_URL", type: "string", def: "—", desc: "Base URL of the Shipwright agents service. When set alongside SHIPWRIGHT_TASK_STORE_AGENTS_API_KEY, the task-store service uses it to resolve agent tokens to their scoped repos. Optional — not required when agents do not need repo-scoping." },
  { name: "SHIPWRIGHT_TASK_STORE_AGENTS_API_KEY", type: "string", def: "—", desc: "Bearer token for the task-store service to call the agents service. Required alongside SHIPWRIGHT_TASK_STORE_AGENTS_URL to enable scope resolution. Env-var-only (secret)." },
  { name: "SHIPWRIGHT_ADMIN_PUBLIC_REPO", type: "string", def: "—", desc: "Repository slug (format: org/repo) scoped for the public read-only task board. When set, GET /public/tasks displays tasks for this repo only, unauthenticated. Optional — omit to disable the public board." },
  { name: "SHIPWRIGHT_ADMIN_TZ", type: "string", def: "America/Los_Angeles", desc: "IANA timezone name (e.g. America/New_York) for date/time display in the admin UI. When unset, defaults to America/Los_Angeles." },
  { name: "METRICS_DASHBOARD_URL", type: "string", def: "/dashboard", desc: "URL for the Metrics toolbar link in the admin UI. Defaults to /dashboard (same-host relative path). Set to an absolute URL when the metrics service runs on a different host or port." },
  { name: "METRICS_ADMIN_APP_URL", type: "string", def: '""', desc: "Base URL of the admin console for the metrics dashboard toolbar Agents/Tasks/PRs links. Defaults to empty (same-host relative links). Set to an absolute URL when the admin console runs on a different origin than the metrics dashboard." },
];

export const agentProvisioningVars: ConfigVar[] = [
  { name: "SHIPWRIGHT_K8S_PROVISIONING", type: "string", def: "—", desc: "Set to enabled to provision a real Kubernetes PersistentVolumeClaim + Secret + Deployment per agent via KubernetesAgentProvisioner. Any other value (or unset) selects the no-op provisioner, preserving DB-only create/delete behavior." },
  { name: "SHIPWRIGHT_K8S_NAMESPACE", type: "string", def: "—", desc: "Target namespace for per-agent PersistentVolumeClaim, Secret, and Deployment. When unset, falls back to the pod's own release namespace. Only read when provisioning is enabled." },
  { name: "SHIPWRIGHT_AGENT_IMAGE", type: "string", def: "—", desc: "Agent container image (without tag) used for the provisioned Deployment. Only read when provisioning is enabled." },
  { name: "SHIPWRIGHT_AGENT_IMAGE_TAG", type: "string", def: "latest", desc: "Image tag joined as image:tag for the provisioned Deployment. Only read when provisioning is enabled." },
  { name: "SHIPWRIGHT_ADMIN_DEPLOYMENT_NAME", type: "string", def: "—", desc: "Name of the admin Deployment, used as the ownerReference target so per-agent resources are garbage-collected with the admin Deployment. Only read when provisioning is enabled." },
  { name: "SHIPWRIGHT_ADMIN_DEPLOYMENT_UID", type: "string", def: "—", desc: "UID of the admin Deployment, paired with SHIPWRIGHT_ADMIN_DEPLOYMENT_NAME for the ownerReference. Only read when provisioning is enabled." },
  { name: "SHIPWRIGHT_AGENT_REPLICAS", type: "number", def: "1", desc: "Replica count for the provisioned agent Deployment. Only read when provisioning is enabled." },
  { name: "SHIPWRIGHT_AGENT_PVC_STORAGE_GI", type: "number", def: "40", desc: "Storage size in Gi for the per-agent persistent home directory (PVC). Only read when provisioning is enabled. Must be large enough to hold mise caches and workspace files across pod restarts." },
  { name: "SHIPWRIGHT_AGENT_PVC_NAME_TEMPLATE", type: "string", def: "—", desc: "Template for deriving the PVC name from the agent's human-readable name. Use {name} as the placeholder. When unset, PVCs are named {sanitizedAgentId}-home. Only read when provisioning is enabled." },
];

export const policyFields: ConfigVar[] = [
  { name: "auto_post_reviews", type: "bool", def: "false", desc: "Post review comments to GitHub automatically without manual approval." },
  { name: "allowed_events", type: "string[]", def: '["COMMENT", "APPROVE"]', desc: "GitHub review event types the agent may emit." },
  { name: "review_external_prs", type: "bool", def: "true", desc: "Review PRs opened by users other than the agent." },
  { name: "allow_self_review", type: "bool", def: "true", desc: "Allow the agent to review its own PRs. Set to false to require a human reviewer on agent-authored PRs." },
  { name: "min_confidence", type: "number", def: "75", desc: "Minimum confidence score (0–100) for a finding to be included in a review." },
  { name: "max_findings", type: "number", def: "5", desc: "Maximum number of findings to include in a single review." },
  { name: "cleanup_merged_worktrees", type: "bool", def: "true", desc: "Automatically remove worktrees for merged branches." },
  { name: "cleanup_after_days", type: "number", def: "14", desc: "Age threshold (days) before a merged-branch worktree is eligible for cleanup." },
];
