/**
 * Admin copy of task-store/src/claim-ttl.ts's DEFAULT_CLAIM_TTL_MS (admin
 * cannot import task-store): claude -p hard timeout (1h) + 5min buffer.
 * claim-ttl.unit.test.ts asserts it equals the task-store value.
 */
export const DEFAULT_CLAIM_TTL_MS = 3_900_000;
