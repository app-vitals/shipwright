/**
 * agent/src/cutover-values.ts
 * Pure YAML generation for the client-agent Helm values cutover patch.
 */

const REMOVE_ENV_VARS = [
  "VITALS_OS_API_URL",
  "VITALS_INTERNAL_API_KEY",
  "VITALS_OS_AGENT_USER_ID",
] as const;

export function generateCutoverValues(
  agentId: string,
  imageTag: string,
  shipwrightApiUrl: string,
): string {
  const removeLines = REMOVE_ENV_VARS.map((v) => `    - ${v}`).join("\n");

  return `# Helm values patch for agent: ${agentId}
# Apply with: helm upgrade <release> <chart> -f values-cutover-${agentId}.yaml
agent:
  image:
    repository: ghcr.io/app-vitals/shipwright-agent
    tag: "${imageTag}"
  env:
    SHIPWRIGHT_API_URL: "${shipwrightApiUrl}"
    SHIPWRIGHT_INTERNAL_API_KEY: ""  # populate from secret
    SHIPWRIGHT_AGENT_ID: "${agentId}"
  removeEnv:
${removeLines}
`;
}
