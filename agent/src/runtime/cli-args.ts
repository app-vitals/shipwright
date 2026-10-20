/**
 * agent/src/runtime/cli-args.ts
 *
 * CLI argument parsing for the agent entrypoint.
 *
 * Parses --agent-id, --api-url, --api-key flags from argv.
 * Falls back to environment variables when flags are absent.
 * Pure — no I/O, no process.env reads at module level.
 */

import { parseFlags } from "@shipwright/lib/cli-flags";

interface CliArgs {
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
  const flags = parseFlags(argv, ["--agent-id", "--api-url", "--api-key"]);

  return {
    agentId: flags["--agent-id"] ?? env.SHIPWRIGHT_AGENT_ID,
    apiUrl: flags["--api-url"] ?? env.SHIPWRIGHT_API_URL,
    apiKey: flags["--api-key"] ?? env.SHIPWRIGHT_AGENT_API_KEY,
  };
}
