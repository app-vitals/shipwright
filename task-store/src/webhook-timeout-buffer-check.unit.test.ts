/**
 * task-store/src/webhook-timeout-buffer-check.unit.test.ts
 *
 * Unit tests for checkWebhookTimeoutBuffer — a pure function that warns when
 * the configured outbound-webhook timeout doesn't leave enough room under the
 * task-write transaction timeout. TSW-1.2 dispatches the webhook from inside
 * those transactions, so if Prisma's transaction clock can fire first a slow
 * receiver surfaces as a 500 rather than the documented 502.
 */

import { describe, expect, test } from "bun:test";
import { WEBHOOK_TX_TIMEOUT_MS } from "./task-service.ts";
import {
  WEBHOOK_TIMEOUT_BUFFER_MS,
  checkWebhookTimeoutBuffer,
} from "./webhook-timeout-buffer-check.ts";

describe("checkWebhookTimeoutBuffer", () => {
  test("returns null when the webhook timeout is comfortably under the transaction timeout", () => {
    expect(checkWebhookTimeoutBuffer(3000, 10_000)).toBeNull();
  });

  test("returns a warning naming both values when the webhook timeout is too large", () => {
    const result = checkWebhookTimeoutBuffer(30_000, 10_000);

    expect(result).not.toBeNull();
    expect(result as string).toContain("30000");
    expect(result as string).toContain("10000");
    expect(result as string).toContain(
      "SHIPWRIGHT_TASK_STORE_WEBHOOK_TIMEOUT_MS",
    );
  });

  test("warns on the exact tie the review flagged: 5000ms webhook vs Prisma's 5000ms default transaction timeout", () => {
    // The pre-fix state — DEFAULT_WEBHOOK_TIMEOUT_MS 5000 with no explicit
    // $transaction timeout, so Prisma's own 5000ms default applied. Zero
    // headroom, and the preceding queries eat into it.
    expect(checkWebhookTimeoutBuffer(5000, 5000)).not.toBeNull();
  });

  test("boundary: exactly at the maximum (transaction timeout minus buffer) does not warn", () => {
    const transactionTimeoutMs = 10_000;
    const atMax = transactionTimeoutMs - WEBHOOK_TIMEOUT_BUFFER_MS;
    expect(checkWebhookTimeoutBuffer(atMax, transactionTimeoutMs)).toBeNull();
  });

  test("boundary: one ms over the maximum warns", () => {
    const transactionTimeoutMs = 10_000;
    const overMax = transactionTimeoutMs - WEBHOOK_TIMEOUT_BUFFER_MS + 1;
    expect(
      checkWebhookTimeoutBuffer(overMax, transactionTimeoutMs),
    ).not.toBeNull();
  });

  test("returns null for a non-finite timeout (a separate misconfiguration, not a headroom problem)", () => {
    expect(checkWebhookTimeoutBuffer(Number.NaN, 10_000)).toBeNull();
  });

  test("the shipped defaults pass their own check with room to spare", () => {
    // Mirrors main.ts's wiring: DEFAULT_WEBHOOK_TIMEOUT_MS (3000) against the
    // real exported WEBHOOK_TX_TIMEOUT_MS. Guards against someone raising the
    // webhook default (or lowering the transaction timeout) back into the
    // collision zone.
    expect(checkWebhookTimeoutBuffer(3000, WEBHOOK_TX_TIMEOUT_MS)).toBeNull();
  });
});
