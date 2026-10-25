/**
 * chat/src/reply-notifier.ts
 * Optional outbound reply-notification webhook (CFB-4.3).
 *
 * Mirrors chat/src/auth.ts's createScopeResolver: an env-gated factory with
 * its own dedicated credential, calling a fixed downstream endpoint with a
 * 5s timeout, and never throwing — every error (network, non-2xx, timeout)
 * is swallowed internally so a push failure can never fail a reply.
 *
 * POST {webhookUrl}
 *   Authorization: Bearer {webhookToken}
 *   { threadId, agentId, title }
 *
 * No message body/preview text is ever included in the payload — see
 * lib/chat-notify.ts for the shared, text-free event shape. `webhookUrl` is
 * the full endpoint URL (e.g. the admin service's
 * "https://admin.example.com/admin/push/notify"), not a base URL.
 */

import type { ReplyNotificationEvent } from "@shipwright/lib/chat-notify";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Factory that builds a reply notifier calling the admin service's inbound
 * push webhook. `fetchImpl` defaults to the global `fetch` in production;
 * tests inject a fake to avoid touching global.fetch (CLAUDE.md hard rule).
 */
export function createReplyNotifier(
  webhookUrl: string,
  webhookToken: string,
  fetchImpl: FetchLike = fetch,
): (event: ReplyNotificationEvent) => Promise<void> {
  return async (event: ReplyNotificationEvent): Promise<void> => {
    try {
      const res = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${webhookToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          threadId: event.threadId,
          agentId: event.agentId,
          title: event.title,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        console.error(`[chat] reply notifier: webhook responded ${res.status}`);
      }
    } catch (err) {
      console.error("[chat] reply notifier: webhook call failed:", err);
    }
  };
}
