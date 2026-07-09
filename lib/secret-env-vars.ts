/**
 * lib/secret-env-vars.ts
 * Canonical list of well-known secret-shaped env var names used by the
 * shipwright-agent framework. Shared by Sentry log/event scrubbing
 * (lib/sentry.ts) and by admin's agent env storage (marks these keys as
 * `secret` so they're masked in GET /agents/:id/envs responses).
 */

/** Secret-shaped env var names, redacted/masked wherever their value is currently set. */
export const SECRET_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GH_APP_PRIVATE_KEY",
  "GH_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_CLIENT_SECRET",
  "SLACK_ADMIN_TOKEN",
  "SHIPWRIGHT_AGENT_API_KEY",
  "SHIPWRIGHT_TASK_STORE_TOKEN",
  "SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN",
  "SHIPWRIGHT_CHAT_SERVICE_TOKEN",
  "SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN",
  "SHIPWRIGHT_ADMIN_API_KEYS",
  "SHIPWRIGHT_SESSION_SECRET",
  "SHIPWRIGHT_ENCRYPTION_KEY",
  "GOOGLE_CLIENT_SECRET",
] as const;
