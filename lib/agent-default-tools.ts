/**
 * The default set of tool patterns seeded as AgentTool rows for a newly
 * created agent. Single source of truth — referenced by both the admin
 * POST /agents route (admin/src/agents-api.ts) and the local dev-agent seed
 * script (scripts/seed-dev-agent.ts) so the two paths can't silently drift
 * apart.
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
