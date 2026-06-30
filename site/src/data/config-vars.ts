export interface ConfigVar {
  name: string;
  type: string;
  def: string;
  desc: string;
}

export const pluginEnvVars: ConfigVar[] = [
  { name: "SHIPWRIGHT_TASK_STORE", type: "string", def: "—", desc: "Selects the task store backend (github, jira, or json). When set, takes precedence over all file-based config — the .shipwright.json walk-up and SHIPWRIGHT_CONFIG are skipped entirely." },
  { name: "SHIPWRIGHT_GITHUB_OWNER", type: "string", def: "—", desc: "GitHub organization or user name. Required when SHIPWRIGHT_TASK_STORE=github." },
  { name: "SHIPWRIGHT_GITHUB_REPO", type: "string", def: "—", desc: "GitHub repository name. Required when SHIPWRIGHT_TASK_STORE=github." },
  { name: "JIRA_BASE_URL", type: "string", def: "—", desc: "Base URL of the Jira instance (e.g. https://example.atlassian.net). Required when SHIPWRIGHT_TASK_STORE=jira." },
  { name: "JIRA_PROJECT_KEY", type: "string", def: "—", desc: "Jira project key (e.g. SHIP). Required when SHIPWRIGHT_TASK_STORE=jira." },
  { name: "SHIPWRIGHT_REPOS_DIR", type: "string", def: "<AGENT_HOME>/workspace/repos", desc: "Override the workspace repos directory." },
  { name: "SHIPWRIGHT_WORKTREE_DIR", type: "string", def: "<AGENT_HOME>/workspace/worktrees", desc: "Override the workspace worktrees directory." },
  { name: "SHIPWRIGHT_DEV_CHAT", type: "bool", def: "false", desc: "Enables the unauthenticated POST /chat endpoint. Must not be set in production." },
  { name: "SHIPWRIGHT_CONFIG", type: "string", def: "—", desc: "Explicit path to .shipwright.json when auto-discovery is not suitable." },
  { name: "GH_CMD", type: "string", def: "gh", desc: "Override the gh CLI executable. Useful in environments where gh is installed to a non-default path." },
  { name: "AGENT_HOME", type: "string", def: "~/.shipwright-agent", desc: "Persistent storage root for workspace files, mise caches, and ~/.claude." },
  { name: "WORKSPACE_PATH", type: "string", def: "—", desc: "Direct workspace path override. Takes precedence over AGENT_HOME-based discovery when set." },
  { name: "JIRA_API_TOKEN", type: "string", def: "—", desc: "API token for Jira authentication. Required when taskStore is jira. Env-var-only (secret)." },
  { name: "JIRA_EMAIL", type: "string", def: "—", desc: "Email address for Jira authentication. Required when taskStore is jira." },
];

export const pluginJsonKeys: ConfigVar[] = [
  { name: "taskStore", type: '"json" | "github" | "jira"', def: "required", desc: "Backend for the task store." },
  { name: "github.owner", type: "string", def: "required if taskStore=github", desc: "GitHub org or user that owns the issues repo." },
  { name: "github.repo", type: "string", def: "required if taskStore=github", desc: "GitHub repo name containing issues used as tasks." },
  { name: "jira.baseUrl", type: "string", def: "required if taskStore=jira", desc: "Base URL of the Jira instance." },
  { name: "jira.projectKey", type: "string", def: "required if taskStore=jira", desc: "Jira project key (e.g. SHIP)." },
  { name: "jira.readyJql", type: "string", def: "—", desc: "Custom JQL to filter ready tasks. Overrides the default status-based query." },
  { name: "jira.statusMap", type: "Record<string, TaskStatus>", def: "—", desc: "Maps Jira status names to Shipwright task statuses." },
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
  { name: "AGENT_HOME", type: "string", def: "~/.shipwright-agent", desc: "Persistent storage root. Mount a PVC here in Kubernetes so mise caches and workspace files survive pod restarts." },
  { name: "MISE_DATA_DIR", type: "string", def: "<AGENT_HOME>/.mise", desc: "Override the mise data directory. Auto-derived from AGENT_HOME." },
  { name: "MISE_CACHE_DIR", type: "string", def: "<AGENT_HOME>/.mise/cache", desc: "Override the mise cache directory." },
  { name: "XDG_CACHE_HOME", type: "string", def: "<AGENT_HOME>/.cache", desc: "Override the XDG cache directory." },
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
