/**
 * chat/src/prisma-client.unit.test.ts
 *
 * Guards the idle-connection failure mode of the Prisma 7 driver adapter.
 * `pg.Pool` is an EventEmitter that re-emits errors raised by idle pooled
 * clients; with no `error` listener, an unhandled `error` event throws and
 * kills this long-lived service. Prisma 6's Rust engine handled connection loss
 * internally, so the listener is what preserves the pre-upgrade behaviour.
 *
 * No I/O: the pool is constructed but never connects — the error path is driven
 * by emitting on the pool directly, the same way node-postgres surfaces an idle
 * client failure.
 */

import { describe, expect, it } from "bun:test";
import { createChatPool } from "./prisma-client.ts";

const UNUSED_URL = "postgresql://chat:chat@127.0.0.1:1/chat_unit_test";

describe("createChatPool", () => {
  it("registers an error listener so idle-client errors cannot crash the process", async () => {
    const pool = createChatPool(UNUSED_URL);

    expect(pool.listenerCount("error")).toBeGreaterThan(0);

    await pool.end();
  });

  it("routes an idle-client error to the logger instead of throwing", async () => {
    const logged: unknown[] = [];
    const pool = createChatPool(UNUSED_URL, (err) => logged.push(err));

    const idleError = new Error("Connection terminated unexpectedly");
    // `emit` returns false when nothing is listening — which is exactly the
    // unhandled-'error' case node would turn into a process-killing throw.
    expect(pool.emit("error", idleError)).toBe(true);

    expect(logged).toEqual([idleError]);

    await pool.end();
  });
});
