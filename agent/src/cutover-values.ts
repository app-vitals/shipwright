/**
 * agent/src/cutover-values.ts
 * Pure function that generates a Helm values patch for cutting an agent over
 * from vitals-os to shipwright.
 *
 * Adds:    SHIPWRIGHT_API_URL, SHIPWRIGHT_INTERNAL_API_KEY, SHIPWRIGHT_AGENT_ID
 * Removes: VITALS_OS_API_URL, VITALS_INTERNAL_API_KEY, VITALS_OS_AGENT_USER_ID
 */

/**
 * Generates a Helm values patch YAML string for a client-agent chart cutover.
 *
 * The caller sets SHIPWRIGHT_API_URL and SHIPWRIGHT_INTERNAL_API_KEY via their
 * own secrets — this patch leaves them empty as placeholders so the operator
 * knows to fill them in.
 */
export function generateCutoverValues(
  agentId: string,
  imageTag: string,
): string {
  return `image:
  tag: "${imageTag}"
env:
  add:
    SHIPWRIGHT_API_URL: ""
    SHIPWRIGHT_INTERNAL_API_KEY: ""
    SHIPWRIGHT_AGENT_ID: "${agentId}"
  remove:
    - VITALS_OS_API_URL
    - VITALS_INTERNAL_API_KEY
    - VITALS_OS_AGENT_USER_ID
`;
}
