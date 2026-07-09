// Builds a console log prefix, tagging lines with the agent ID (when set) so
// they're attributable in an aggregated multi-agent log view.
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
