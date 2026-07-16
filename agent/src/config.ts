import { join } from "node:path";

// Default hard timeout for a single `claude -p` session — mirrors the default
// in createRunClaude (agent/src/claude.ts). Kept in sync so behavior is
// unchanged when SHIPWRIGHT_CLAUDE_TIMEOUT_MS is unset.
const DEFAULT_CLAUDE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function optional(key: string): string | undefined {
  return process.env[key];
}

/**
 * Reads a positive-integer millisecond env var, falling back to `fallback`
 * when the value is unset, non-numeric, non-integer, zero, or negative — so a
 * malformed override never silently disables or shortens the timeout.
 */
function positiveIntMs(key: string, fallback: number): number {
  const raw = optional(key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function buildConfig(agentHome: string) {
  return {
    claude: {
      model: optional("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6",
      fallbackModel: optional("ANTHROPIC_FALLBACK_MODEL"),
      effortLevel: optional("ANTHROPIC_EFFORT_LEVEL"),
      timeoutMs: positiveIntMs(
        "SHIPWRIGHT_CLAUDE_TIMEOUT_MS",
        DEFAULT_CLAUDE_TIMEOUT_MS,
      ),
      anthropicApiKey: optional("ANTHROPIC_API_KEY"),
      oauthToken: optional("CLAUDE_CODE_OAUTH_TOKEN"),
    },
    shipwright: {
      apiUrl: optional("SHIPWRIGHT_API_URL"),
      apiKey: optional("SHIPWRIGHT_AGENT_API_KEY"),
      agentId: optional("SHIPWRIGHT_AGENT_ID"),
    },
    slack: {
      botToken: optional("SLACK_BOT_TOKEN"),
      appToken: optional("SLACK_APP_TOKEN"),
      signingSecret: optional("SLACK_SIGNING_SECRET"),
      adminToken: optional("SLACK_ADMIN_TOKEN"),
    },
    alerts: {
      channel: optional("SLACK_ALERT_CHANNEL"),
    },
    owner: {
      user: optional("SLACK_OWNER_USER"),
    },
    voice: {
      groqApiKey: optional("GROQ_API_KEY"),
      elevenLabsApiKey: optional("ELEVENLABS_API_KEY"),
      voiceId: optional("ELEVENLABS_VOICE_ID"),
      whisperServiceUrl: optional("WHISPER_SERVICE_URL"),
    },
    chat: {
      serviceUrl: optional("SHIPWRIGHT_CHAT_SERVICE_URL"),
      serviceToken: optional("SHIPWRIGHT_CHAT_SERVICE_TOKEN"),
      pollIntervalMs: optional("SHIPWRIGHT_CHAT_POLL_INTERVAL_MS")
        ? Number(optional("SHIPWRIGHT_CHAT_POLL_INTERVAL_MS"))
        : undefined,
    },
    paths: {
      home: agentHome,
      workspace: join(agentHome, "workspace"),
      sessions: join(agentHome, "sessions.json"),
      chatSessions: join(agentHome, "chat-sessions.json"),
    },
  } as const;
}

/**
 * Creates config from a given agent home directory.
 * Reads env vars at call time — no module-level side effects.
 *
 * AGENT_HOME defaults to ~/.shipwright-agent/ at the call site (index.ts).
 * Not defaulted here to avoid module-level env reads.
 */
export function createConfig(agentHome: string) {
  return {
    config: buildConfig(agentHome),
  };
}
