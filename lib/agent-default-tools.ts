/**
 * The default set of tool patterns seeded as AgentTool rows for a newly
 * created agent via the admin POST /agents route
 * (admin/src/agents-api.ts). Single source of truth for that route.
 */
export const DEFAULT_ADMIN_AGENT_TOOLS = ["Bash", "WebSearch", "WebFetch", "Agent"];

/**
 * The full tool set seeded for the local dev agent by
 * scripts/seed-dev-agent.ts. Broader than DEFAULT_ADMIN_AGENT_TOOLS since
 * the dev agent is used interactively and benefits from the full toolset.
 * Single source of truth for that script.
 */
export const DEFAULT_AGENT_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "WebSearch",
  "WebFetch",
  "Skill",
  "Agent",
];
