/**
 * Log prefix builder for multi-agent log aggregation.
 * Constructs a prefix that includes the agent ID (when set) for attributability
 * in aggregated multi-agent log views.
 */

/**
 * Build a log prefix that includes timestamp and optional agent ID.
 *
 * @param agentId - The agent ID from config (may be undefined in local/dev)
 * @param timestamp - ISO 8601 timestamp string
 * @returns A log prefix string in format "[ISO-TIMESTAMP] [agent:ID]" or just "[ISO-TIMESTAMP]"
 *
 * When agentId is undefined or empty string, returns just the timestamp.
 * No "undefined" literal appears in the output.
 */
export function buildLogPrefix(
  agentId: string | undefined,
  timestamp: string,
): string {
  const timestampPart = `[${timestamp}]`;
  if (!agentId) {
    return timestampPart;
  }
  return `${timestampPart} [agent:${agentId}]`;
}
