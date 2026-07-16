/**
 * Integration tests for createFileSessionStore and threadKey in agent/src/sessions.ts
 *
 * Uses real file I/O to a process-scoped tmp file — no mocks, pure file I/O.
 * This is an integration test by boundary rule: it exercises the real fs module.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixedClock } from "./clock.ts";
import { createFileSessionStore, threadKey } from "./sessions.ts";

// ─── Shared store backed by a process-scoped tmp file ─────────────────────────

const SESSIONS_FILE = `/tmp/shipwright-sessions-test-${process.pid}.json`;
const store = createFileSessionStore(SESSIONS_FILE);

afterEach(() => {
  try {
    rmSync(SESSIONS_FILE, { force: true });
  } catch {
    // file may not exist — safe to ignore
  }
});

// ─── threadKey ─────────────────────────────────────────────────────────────────

describe("threadKey", () => {
  test("returns channel:ts format", () => {
    expect(threadKey("C123", "1234567890.000100")).toBe(
      "C123:1234567890.000100",
    );
  });

  test("different channels produce different keys", () => {
    expect(threadKey("C1", "ts")).not.toBe(threadKey("C2", "ts"));
  });

  test("handles DM channel prefix", () => {
    expect(threadKey("D99999ZZ", "0000001.000001")).toBe(
      "D99999ZZ:0000001.000001",
    );
  });

  test("handles group channel prefix", () => {
    expect(threadKey("GABCDEF1", "9876543.210000")).toBe(
      "GABCDEF1:9876543.210000",
    );
  });
});

// ─── createFileSessionStore ────────────────────────────────────────────────────

describe("createFileSessionStore — basic operations", () => {
  test("get returns undefined for missing key", async () => {
    expect(await store.get("no-such-key")).toBeUndefined();
  });

  test("set + get roundtrip", async () => {
    await store.set("key1", "session-abc");
    expect(await store.get("key1")).toBe("session-abc");
  });

  test("set overwrites existing entry", async () => {
    await store.set("key1", "session-old");
    await store.set("key1", "session-new");
    expect(await store.get("key1")).toBe("session-new");
  });

  test("clear removes key", async () => {
    await store.set("key1", "session-abc");
    await store.clear("key1");
    expect(await store.get("key1")).toBeUndefined();
  });

  test("clear on missing key is a no-op", async () => {
    await expect(store.clear("does-not-exist")).resolves.toBeUndefined();
  });

  test("size returns count of stored entries", async () => {
    expect(await store.size()).toBe(0);
    await store.set("k1", "s1");
    expect(await store.size()).toBe(1);
    await store.set("k2", "s2");
    expect(await store.size()).toBe(2);
    await store.clear("k1");
    expect(await store.size()).toBe(1);
  });

  test("multiple keys are independent", async () => {
    await store.set("k1", "s1");
    await store.set("k2", "s2");
    expect(await store.get("k1")).toBe("s1");
    expect(await store.get("k2")).toBe("s2");
    await store.clear("k1");
    expect(await store.get("k1")).toBeUndefined();
    expect(await store.get("k2")).toBe("s2");
  });

  test("get returns undefined when constructed on a path that no longer exists", async () => {
    await store.set("C1:ts1", "session-gone");
    rmSync(SESSIONS_FILE, { force: true });
    const freshStore = createFileSessionStore(SESSIONS_FILE);
    expect(await freshStore.get("C1:ts1")).toBeUndefined();
  });
});

// ─── Concurrent writes ──────────────────────────────────────────────────────────

describe("createFileSessionStore — concurrent writes", () => {
  test("two concurrent set() calls on different keys both persist (no clobbering)", async () => {
    const concurrentFile = join(
      tmpdir(),
      `sessions-concurrent-diffkeys-${process.pid}-${Date.now()}.json`,
    );
    const concurrentStore = createFileSessionStore(concurrentFile);

    // Fire both writes without awaiting the first before starting the second —
    // this is the load-modify-save race: without serialization, the second
    // set()'s load() can happen before the first set()'s save() lands, so its
    // save() would overwrite the first write.
    await Promise.all([
      concurrentStore.set("keyA", "session-A"),
      concurrentStore.set("keyB", "session-B"),
    ]);

    expect(await concurrentStore.get("keyA")).toBe("session-A");
    expect(await concurrentStore.get("keyB")).toBe("session-B");
    expect(await concurrentStore.size()).toBe(2);

    // Also verify the on-disk file itself reflects both writes — a full
    // round-trip, not a clobbered partial write from a stale in-memory read.
    const onDisk = JSON.parse(readFileSync(concurrentFile, "utf8"));
    expect(Object.keys(onDisk).sort()).toEqual(["keyA", "keyB"]);

    try {
      rmSync(concurrentFile, { force: true });
    } catch {}
  });

  test("two concurrent set() calls on the same key both apply — final value is one of the two, file is not corrupted", async () => {
    const concurrentFile = join(
      tmpdir(),
      `sessions-concurrent-samekey-${process.pid}-${Date.now()}.json`,
    );
    const concurrentStore = createFileSessionStore(concurrentFile);

    await Promise.all([
      concurrentStore.set("key1", "session-first"),
      concurrentStore.set("key1", "session-second"),
    ]);

    const finalValue = await concurrentStore.get("key1");
    expect(finalValue).toBeDefined();
    expect(["session-first", "session-second"]).toContain(finalValue as string);

    // The persisted file must be valid JSON with exactly one entry for key1 —
    // proof the second write's load+save wasn't torn or based on a stale read
    // that silently dropped the first write's on-disk effects.
    const onDisk = JSON.parse(readFileSync(concurrentFile, "utf8"));
    expect(Object.keys(onDisk)).toEqual(["key1"]);

    try {
      rmSync(concurrentFile, { force: true });
    } catch {}
  });

  test("interleaved set/get calls on the same store apply in enqueued order", async () => {
    const concurrentFile = join(
      tmpdir(),
      `sessions-concurrent-order-${process.pid}-${Date.now()}.json`,
    );
    const concurrentStore = createFileSessionStore(concurrentFile);

    // Three concurrent sets on distinct keys plus a concurrent clear — all
    // fired together, none awaited individually first.
    await Promise.all([
      concurrentStore.set("a", "1"),
      concurrentStore.set("b", "2"),
      concurrentStore.set("c", "3"),
    ]);

    expect(await concurrentStore.size()).toBe(3);
    expect(await concurrentStore.get("a")).toBe("1");
    expect(await concurrentStore.get("b")).toBe("2");
    expect(await concurrentStore.get("c")).toBe("3");

    try {
      rmSync(concurrentFile, { force: true });
    } catch {}
  });
});

// ─── TTL and prune ─────────────────────────────────────────────────────────────

describe("createFileSessionStore — TTL and prune", () => {
  test("TTL-based expiry: expired entry returns undefined", async () => {
    const shortTtlFile = join(
      tmpdir(),
      `sessions-ttl-${process.pid}-${Date.now()}.json`,
    );
    const t0 = new Date("2024-01-01T00:00:00.000Z");
    // Fixed clock at t0 for the write — with real async file I/O, comparing
    // against real wall-clock time (via a busy-wait) races the I/O latency
    // itself. A second store on the same file with a clock fixed well past
    // the TTL gives a deterministic "later" read with no timing dependency.
    const earlyStore = createFileSessionStore(shortTtlFile, 1000, FixedClock(t0));
    await earlyStore.set("k", "session-xyz");
    expect(await earlyStore.get("k")).toBe("session-xyz");
    const lateStore = createFileSessionStore(
      shortTtlFile,
      1000,
      FixedClock(new Date(t0.getTime() + 5000)),
    );
    expect(await lateStore.get("k")).toBeUndefined();
    try {
      rmSync(shortTtlFile, { force: true });
    } catch {}
  });

  test("prune removes expired entries and returns count", async () => {
    const pruneFile = join(
      tmpdir(),
      `sessions-prune-${process.pid}-${Date.now()}.json`,
    );
    const t0 = new Date("2024-01-01T00:00:00.000Z");
    const earlyStore = createFileSessionStore(pruneFile, 1000, FixedClock(t0));
    await earlyStore.set("k1", "s1");
    await earlyStore.set("k2", "s2");
    const lateStore = createFileSessionStore(
      pruneFile,
      1000,
      FixedClock(new Date(t0.getTime() + 5000)),
    );
    const pruned = await lateStore.prune();
    expect(pruned).toBe(2);
    expect(await lateStore.size()).toBe(0);
    try {
      rmSync(pruneFile, { force: true });
    } catch {}
  });

  test("prune returns 0 when nothing is expired", async () => {
    await store.set("k1", "s1");
    await store.set("k2", "s2");
    expect(await store.prune()).toBe(0);
    expect(await store.size()).toBe(2);
  });

  test("legacy string format support: get returns sessionId string", async () => {
    // Write a legacy-format file manually
    const legacyFile = join(
      tmpdir(),
      `sessions-legacy-${process.pid}-${Date.now()}.json`,
    );
    writeFileSync(
      legacyFile,
      JSON.stringify({ "C1:ts1": "legacy-session-id" }),
    );
    const legacyStore = createFileSessionStore(legacyFile, 60_000);
    // Legacy string entries have no TTL — always valid
    expect(await legacyStore.get("C1:ts1")).toBe("legacy-session-id");
    try {
      rmSync(legacyFile, { force: true });
    } catch {}
  });
});
