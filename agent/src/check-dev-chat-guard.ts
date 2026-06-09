#!/usr/bin/env bun
/** CI guard: exits 1 if SHIPWRIGHT_DEV_CHAT is set in a production config. Run via `task doctor`. */

import { checkDevChatProductionGuard } from "./chat.ts";

const result = checkDevChatProductionGuard(
  process.env as Record<string, string | undefined>,
);

if (!result.ok) {
  process.stderr.write(`[dev-chat-guard] FAIL: ${result.reason}\n`);
  process.exit(1);
}

console.log("[dev-chat-guard] ok");
