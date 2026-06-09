#!/usr/bin/env bun
/**
 * agent/src/check-dev-chat-guard.ts
 *
 * CLI guard: fails with a non-zero exit code if SHIPWRIGHT_DEV_CHAT is set
 * in a production config. Run as part of `task doctor`.
 *
 * Usage:
 *   bun agent/src/check-dev-chat-guard.ts
 */

import { checkDevChatProductionGuard } from "./chat.ts";

const result = checkDevChatProductionGuard(
  process.env as Record<string, string | undefined>,
);

if (!result.ok) {
  process.stderr.write(`[dev-chat-guard] FAIL: ${result.reason}\n`);
  process.exit(1);
}

console.log("[dev-chat-guard] ok");
