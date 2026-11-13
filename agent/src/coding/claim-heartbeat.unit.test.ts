import { describe, expect, test } from "bun:test";
import { startClaimHeartbeat } from "./claim-heartbeat.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("startClaimHeartbeat", () => {
  test("renews the task on every interval until stopped", async () => {
    const calls: string[] = [];
    const stop = startClaimHeartbeat(
      async (id) => {
        calls.push(id);
      },
      "T-1",
      10,
    );
    await sleep(55);
    stop();
    const n = calls.length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(new Set(calls)).toEqual(new Set(["T-1"]));
    await sleep(40);
    expect(calls.length).toBe(n);
  });

  test("a failed renewal is logged and does not stop later renewals", async () => {
    let calls = 0;
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => warnings.push(String(m));
    try {
      const stop = startClaimHeartbeat(
        async () => {
          calls += 1;
          throw new Error("boom");
        },
        "T-2",
        10,
      );
      await sleep(45);
      stop();
    } finally {
      console.warn = orig;
    }
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(warnings[0]).toContain("periodic heartbeatTask failed for T-2");
  });
});
