/**
 * Integration tests for createFileSessionStore and threadKey in agent/src/sessions.ts
 *
 * Uses real file I/O to a process-scoped tmp file — no mocks, pure file I/O.
 * This is an integration test by boundary rule: it exercises the real fs module.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  test("get returns undefined for missing key", () => {
    expect(store.get("no-such-key")).toBeUndefined();
  });

  test("set + get roundtrip", () => {
    store.set("key1", "session-abc");
    expect(store.get("key1")).toBe("session-abc");
  });

  test("set overwrites existing entry", () => {
    store.set("key1", "session-old");
    store.set("key1", "session-new");
    expect(store.get("key1")).toBe("session-new");
  });

  test("clear removes key", () => {
    store.set("key1", "session-abc");
    store.clear("key1");
    expect(store.get("key1")).toBeUndefined();
  });

  test("clear on missing key is a no-op", () => {
    expect(() => store.clear("does-not-exist")).not.toThrow();
  });

  test("size returns count of stored entries", () => {
    expect(store.size()).toBe(0);
    store.set("k1", "s1");
    expect(store.size()).toBe(1);
    store.set("k2", "s2");
    expect(store.size()).toBe(2);
    store.clear("k1");
    expect(store.size()).toBe(1);
  });

  test("multiple keys are independent", () => {
    store.set("k1", "s1");
    store.set("k2", "s2");
    expect(store.get("k1")).toBe("s1");
    expect(store.get("k2")).toBe("s2");
    store.clear("k1");
    expect(store.get("k1")).toBeUndefined();
    expect(store.get("k2")).toBe("s2");
  });

  test("get returns undefined when constructed on a path that no longer exists", () => {
    store.set("C1:ts1", "session-gone");
    rmSync(SESSIONS_FILE, { force: true });
    const freshStore = createFileSessionStore(SESSIONS_FILE);
    expect(freshStore.get("C1:ts1")).toBeUndefined();
  });
});

// ─── TTL and prune ─────────────────────────────────────────────────────────────

describe("createFileSessionStore — TTL and prune", () => {
  test("TTL-based expiry: expired entry returns undefined", () => {
    const shortTtlFile = join(
      tmpdir(),
      `sessions-ttl-${process.pid}-${Date.now()}.json`,
    );
    const shortStore = createFileSessionStore(shortTtlFile, 1); // 1ms TTL
    shortStore.set("k", "session-xyz");
    expect(shortStore.get("k")).toBe("session-xyz");
    // Busy-wait 50ms — well above the 1ms TTL, guarantees expiry
    const start = Date.now();
    while (Date.now() - start < 50) {}
    expect(shortStore.get("k")).toBeUndefined();
    try {
      rmSync(shortTtlFile, { force: true });
    } catch {}
  });

  test("prune removes expired entries and returns count", () => {
    const pruneFile = join(
      tmpdir(),
      `sessions-prune-${process.pid}-${Date.now()}.json`,
    );
    const pruneStore = createFileSessionStore(pruneFile, 1); // 1ms TTL
    pruneStore.set("k1", "s1");
    pruneStore.set("k2", "s2");
    // Busy-wait 50ms — well above the 1ms TTL, guarantees all entries expired
    const start = Date.now();
    while (Date.now() - start < 50) {}
    const pruned = pruneStore.prune();
    expect(pruned).toBe(2);
    expect(pruneStore.size()).toBe(0);
    try {
      rmSync(pruneFile, { force: true });
    } catch {}
  });

  test("prune returns 0 when nothing is expired", () => {
    store.set("k1", "s1");
    store.set("k2", "s2");
    expect(store.prune()).toBe(0);
    expect(store.size()).toBe(2);
  });

  test("legacy string format support: get returns sessionId string", () => {
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
    expect(legacyStore.get("C1:ts1")).toBe("legacy-session-id");
    try {
      rmSync(legacyFile, { force: true });
    } catch {}
  });
});
