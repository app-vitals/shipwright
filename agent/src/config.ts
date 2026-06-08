import { join } from "node:path";

function optional(key: string): string | undefined {
  return process.env[key];
}

function buildConfig(agentHome: string) {
  return {
    claude: {
      model: optional("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6",
      fallbackModel: optional("ANTHROPIC_FALLBACK_MODEL"),
      effortLevel: optional("ANTHROPIC_EFFORT_LEVEL"),
      anthropicApiKey: optional("ANTHROPIC_API_KEY"),
      oauthToken: optional("CLAUDE_CODE_OAUTH_TOKEN"),
    },
    shipwright: {
      apiUrl: optional("SHIPWRIGHT_API_URL"),
      apiKey: optional("SHIPWRIGHT_INTERNAL_API_KEY"),
      agentId: optional("SHIPWRIGHT_AGENT_ID"),
    },
    paths: {
      home: agentHome,
      workspace: join(agentHome, "workspace"),
      sessions: join(agentHome, "sessions.json"),
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
