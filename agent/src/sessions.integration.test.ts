/**
 * Integration tests for createFileSessionStore and threadKey in agent/src/sessions.ts
 *
 * Uses real file I/O to tmp files — correct by the boundary rule (filesystem = external dependency).
 * No mocks, no test-env.ts import needed.
 */

import { afterEach, afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileSessionStore, threadKey } from "./sessions.ts";

const TMP_DIR = mkdtempSync(join(tmpdir(), "sessions-integration-test-"));
const SESSIONS_FILE = join(TMP_DIR, "sessions.json");

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// ─── threadKey ─────────────────────────────────────────────────────────────

describe("threadKey", () => {
  test("returns channel:ts format", () => {
    expect(threadKey("C123", "1234567890.000100")).toBe(
      "C123:1234567890.000100",
    );
  });

  test("different channels produce different keys", () => {
    expect(threadKey("C1", "ts")).not.toBe(threadKey("C2", "ts"));
  });

  test("handles D prefix (DMs)", () => {
    expect(threadKey("D99999ZZ", "0000001.000001")).toBe(
      "D99999ZZ:0000001.000001",
    );
  });

  test("handles G prefix (group channels)", () => {
    expect(threadKey("GABCDEF1", "9876543.210000")).toBe(
      "GABCDEF1:9876543.210000",
    );
  });
});

// ─── createFileSessionStore ────────────────────────────────────────────────

describe("createFileSessionStore", () => {
  let store: ReturnType<typeof createFileSessionStore>;
  let currentFile: string;

  beforeEach(() => {
    // Fresh file path per test group to avoid bleed
    currentFile = join(TMP_DIR, `sessions-${Date.now()}-${Math.random()}.json`);
    store = createFileSessionStore(currentFile, 60_000);
  });

  afterEach(() => {
    try {
      rmSync(currentFile);
    } catch {
      // file may not exist
    }
  });

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

  test("TTL-based expiry: expired entry returns undefined", () => {
    const shortTtlFile = join(
      TMP_DIR,
      `sessions-ttl-${Date.now()}.json`,
    );
    const shortStore = createFileSessionStore(shortTtlFile, 1); // 1ms TTL
    shortStore.set("k", "session-xyz");
    // The set() writes updatedAt = Date.now(). We need it to expire.
    // Spin until enough time has passed (should be near-instant).
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const val = shortStore.get("k");
      if (val === undefined) break;
    }
    expect(shortStore.get("k")).toBeUndefined();
  });

  test("prune removes expired entries and returns count", () => {
    const pruneFile = join(TMP_DIR, `sessions-prune-${Date.now()}.json`);
    const pruneStore = createFileSessionStore(pruneFile, 1); // 1ms TTL
    pruneStore.set("k1", "s1");
    pruneStore.set("k2", "s2");
    // Wait for TTL to expire
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (pruneStore.size() === 0) break;
      const pruned = pruneStore.prune();
      if (pruned > 0) break;
    }
    expect(pruneStore.size()).toBe(0);
  });

  test("prune returns 0 when nothing is expired", () => {
    store.set("k1", "s1");
    store.set("k2", "s2");
    expect(store.prune()).toBe(0);
    expect(store.size()).toBe(2);
  });

  test("legacy string format support: get returns sessionId string", () => {
    // Write a legacy-format file manually
    const legacyFile = join(TMP_DIR, `sessions-legacy-${Date.now()}.json`);
    writeFileSync(
      legacyFile,
      JSON.stringify({ "C1:ts1": "legacy-session-id" }),
    );
    const legacyStore = createFileSessionStore(legacyFile, 60_000);
    // Legacy string entries have no TTL — always valid
    expect(legacyStore.get("C1:ts1")).toBe("legacy-session-id");
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

  test("store.get() returns undefined after backing file is deleted and new store constructed on same path", () => {
    store.set("k1", "session-to-delete");
    expect(store.get("k1")).toBe("session-to-delete");

    // Delete the backing file
    rmSync(currentFile);

    // Construct a new store on the same path
    const freshStore = createFileSessionStore(currentFile, 60_000);
    expect(freshStore.get("k1")).toBeUndefined();
  });
});
