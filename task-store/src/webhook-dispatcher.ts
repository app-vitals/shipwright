/**
 * task-store/src/webhook-dispatcher.ts
 * Outbound webhook config + generic event dispatcher (TSW-1.1).
 *
 * POSTs a JSON envelope `{ type, data }` to a configured downstream URL:
 *
 *   POST {webhookUrl}
 *     Authorization: Bearer {webhookToken}          (only when a token is set)
 *     X-Shipwright-Signature: sha256={hmac}          (HMAC-SHA256 over the raw
 *                                                      body, keyed by the
 *                                                      token; only when a
 *                                                      token is set — there's
 *                                                      no key to sign with
 *                                                      otherwise)
 *     { "type": string, "data": unknown }
 *
 * Unlike chat/src/reply-notifier.ts (which swallows delivery failures so a
 * push failure can never fail a reply), this dispatcher throws
 * `WebhookDeliveryError` on any non-2xx response, network error, or timeout —
 * callers that care about delivery can catch/retry/log; callers that don't
 * can ignore the rejection. When `url` is unset, `createWebhookDispatcher`
 * returns a no-op dispatcher so call sites never have to branch on whether
 * webhooks are configured.
 */

import { createHmac } from "node:crypto";
import { WebhookDeliveryError } from "./errors.ts";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type WebhookDispatcher = (type: string, data: unknown) => Promise<void>;

/**
 * Factory that builds a generic outbound event dispatcher. `fetchImpl`
 * defaults to the global `fetch` in production; tests inject a fake to avoid
 * touching global.fetch (CLAUDE.md test-isolation hard rule).
 *
 * Returns a no-op dispatcher when `url` is falsy (unset/empty) — main.ts
 * wires this unconditionally from env, so TaskService and its callers never
 * need to check whether webhooks are configured.
 */
export function createWebhookDispatcher(
  url: string | undefined,
  token: string | undefined,
  timeoutMs: number,
  fetchImpl: FetchLike = fetch,
): WebhookDispatcher {
  if (!url) {
    return async () => {};
  }

  return async (type: string, data: unknown): Promise<void> => {
    const body = JSON.stringify({ type, data });
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      headers["X-Shipwright-Signature"] =
        `sha256=${createHmac("sha256", token).update(body).digest("hex")}`;
    }

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new WebhookDeliveryError(
        `webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      throw new WebhookDeliveryError(
        `webhook responded with status ${res.status}`,
      );
    }
  };
}
