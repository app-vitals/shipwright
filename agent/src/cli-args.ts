/**
 * agent/src/cli-args.ts
 *
 * CLI argument parsing for the agent entrypoint.
 *
 * Parses --agent-id, --api-url, --api-key flags from argv.
 * Falls back to environment variables when flags are absent.
 * Pure — no I/O, no process.env reads at module level.
 */

export interface CliArgs {
  agentId: string | undefined;
  apiUrl: string | undefined;
  apiKey: string | undefined;
}

/**
 * Parses CLI arguments and merges with env var fallbacks.
 *
 * @param argv - argument list (without the node/bun executable prefix, i.e. process.argv.slice(2))
 * @param env  - environment variable map (pass process.env or a subset for testing)
 */
export function parseCliArgs(
  argv: string[],
  env: Record<string, string | undefined>,
): CliArgs {
  const flags: Record<string, string> = {};

  for (let i = 0; i < argv.length - 1; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--agent-id") {
      flags.agentId = value;
      i++;
    } else if (flag === "--api-url") {
      flags.apiUrl = value;
      i++;
    } else if (flag === "--api-key") {
      flags.apiKey = value;
      i++;
    }
  }

  return {
    agentId: flags.agentId ?? env.SHIPWRIGHT_AGENT_ID,
    apiUrl: flags.apiUrl ?? env.SHIPWRIGHT_API_URL,
    apiKey: flags.apiKey ?? env.SHIPWRIGHT_INTERNAL_API_KEY,
  };
}
