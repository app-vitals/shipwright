/**
 * agent/src/check-dev-chat-guard.ts
 *
 * Doctor guard script for SHIPWRIGHT_DEV_CHAT.
 * Fails with exit 1 if SHIPWRIGHT_DEV_CHAT is set in the environment.
 *
 * Run as part of `task doctor` to enforce that the dev chat endpoint is
 * never accidentally enabled in a production deployment.
 *
 * Usage: bun agent/src/check-dev-chat-guard.ts
 */

import { checkDevChatGuard } from "./chat.ts";

if (import.meta.main) {
  const result = checkDevChatGuard(process.env as Record<string, string | undefined>);
  if (!result.ok) {
    console.error(`[error] ${result.reason}`);
    process.exit(1);
  }
  console.log("[ok] SHIPWRIGHT_DEV_CHAT: not set");
  process.exit(0);
}
