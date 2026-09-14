/**
 * task-store/src/webhook-timeout-buffer-check.ts
 *
 * checkWebhookTimeoutBuffer — a pure sanity check run once at task-store
 * startup, mirroring `claim-ttl-buffer-check.ts`'s shape and purpose.
 *
 * TSW-1.2 moved the outbound `task.write` dispatch *inside* the task
 * lifecycle `$transaction`s, which means two independent clocks now race on
 * every dispatching write:
 *
 *   1. The dispatcher's own `AbortSignal.timeout(webhookTimeoutMs)`.
 *   2. Prisma's interactive-transaction `timeout`, which starts when the
 *      transaction *opens* — i.e. before the preceding
 *      findUnique/update/recordTaskTransition queries, not when the webhook
 *      call starts.
 *
 * Only clock (1) produces the documented behavior: `WebhookDeliveryError` →
 * 502, transaction rolled back. If clock (2) fires first, Prisma throws its
 * own transaction-already-closed error, which isn't an `ApiError` at all and
 * so surfaces as a generic 500 from app.ts's `onError`.
 *
 * `WEBHOOK_TX_TIMEOUT_MS` (task-service.ts) raises clock (2) well clear of
 * the *default* webhook timeout, but `SHIPWRIGHT_TASK_STORE_WEBHOOK_TIMEOUT_MS`
 * is operator-configurable and can be set arbitrarily high — which would
 * silently reintroduce the 500-instead-of-502 collision. This check makes
 * that misconfiguration loud at boot instead of latent until a receiver gets
 * slow.
 */

/**
 * Headroom reserved, inside the transaction budget, for the queries that run
 * *before* the dispatcher (the before-read, the update, and the TaskEvent
 * audit insert). The webhook timeout has to fit in what's left, or Prisma's
 * clock can still win the race.
 */
export const WEBHOOK_TIMEOUT_BUFFER_MS = 2000;

/**
 * Returns a warning message when `webhookTimeoutMs` doesn't leave enough room
 * under `transactionTimeoutMs` for the pre-dispatch queries, or `null` when
 * the check passes.
 */
export function checkWebhookTimeoutBuffer(
  webhookTimeoutMs: number,
  transactionTimeoutMs: number,
): string | null {
  // A non-finite value (e.g. SHIPWRIGHT_TASK_STORE_WEBHOOK_TIMEOUT_MS set to
  // a non-numeric string, which Number() turns into NaN) is a separate
  // configuration problem; don't emit a confusing headroom warning for it.
  if (!Number.isFinite(webhookTimeoutMs)) {
    return null;
  }

  const maximumWebhookTimeoutMs =
    transactionTimeoutMs - WEBHOOK_TIMEOUT_BUFFER_MS;
  if (webhookTimeoutMs <= maximumWebhookTimeoutMs) {
    return null;
  }

  return `[task-store] SHIPWRIGHT_TASK_STORE_WEBHOOK_TIMEOUT_MS (${webhookTimeoutMs}ms) does not leave enough headroom under the ${transactionTimeoutMs}ms task-write transaction timeout (maximum: ${maximumWebhookTimeoutMs}ms, reserving ${WEBHOOK_TIMEOUT_BUFFER_MS}ms for the queries that precede the dispatch). A slow webhook receiver would trip Prisma's transaction timeout before the dispatcher's own timeout, surfacing as a 500 instead of the documented 502. Lower SHIPWRIGHT_TASK_STORE_WEBHOOK_TIMEOUT_MS to at most ${maximumWebhookTimeoutMs}ms.`;
}
