/**
 * Sends a "back online" DM to the agent owner on startup.
 *
 * Non-fatal: silently skips if owner is not configured, channel-id is missing,
 * or the Slack API throws. Extracted for testability.
 */

import type { WebClient } from "@slack/web-api";

export async function sendBackOnlineDm(
  slack: WebClient,
  ownerUser: string | undefined,
): Promise<void> {
  if (!ownerUser) return;
  try {
    const dm = await slack.conversations.open({ users: ownerUser });
    if (dm.channel?.id) {
      await slack.chat.postMessage({ channel: dm.channel.id, text: "back online" });
    }
  } catch (err) {
    console.warn(
      "[agent] back-online DM failed (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
  }
}
