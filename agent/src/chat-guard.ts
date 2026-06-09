/**
 * agent/src/chat-guard.ts
 *
 * Doctor/CI guard for the dev-only POST /chat transport.
 *
 * The dev chat endpoint is an unauthenticated local convenience and must never
 * be enabled in a production deployment. This module exposes a PURE predicate
 * over an injected env object (deterministically unit-testable, no process.env
 * reads) plus a thin CLI entry that reads process.env ONCE at the edge.
 */

export interface DevChatGuardEnv {
  SHIPWRIGHT_DEV_CHAT?: string;
  NODE_ENV?: string;
}

/**
 * Returns a human-readable violation reason when the dev chat flag is enabled
 * in a production config, otherwise null.
 *
 * Violation iff SHIPWRIGHT_DEV_CHAT === "true" AND NODE_ENV === "production".
 */
export function devChatGuardViolation(env: DevChatGuardEnv): string | null {
  const enabled = env.SHIPWRIGHT_DEV_CHAT === "true";
  const isProduction = env.NODE_ENV === "production";
  if (enabled && isProduction) {
    return "SHIPWRIGHT_DEV_CHAT is enabled in a production config (NODE_ENV=production). The dev /chat endpoint is unauthenticated and must be disabled in production.";
  }
  return null;
}

// CLI entry — reads process.env ONCE at the edge, never inside the predicate.
if (import.meta.main) {
  const reason = devChatGuardViolation({
    SHIPWRIGHT_DEV_CHAT: process.env.SHIPWRIGHT_DEV_CHAT,
    NODE_ENV: process.env.NODE_ENV,
  });
  if (reason) {
    console.error(`[chat-guard] ${reason}`);
    process.exit(1);
  }
  console.log("[chat-guard] ok");
}
