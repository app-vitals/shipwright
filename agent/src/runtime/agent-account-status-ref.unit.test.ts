import { describe, expect, test } from "bun:test";
import { createAgentAccountStatusRef } from "./agent-account-status-ref.ts";

describe("createAgentAccountStatusRef", () => {
  test("defaults to unsynced with a null status", () => {
    const ref = createAgentAccountStatusRef();
    expect(ref.hasSynced()).toBe(false);
    expect(ref.get()).toBeNull();
  });

  test("set() stores the status and marks the ref synced", () => {
    const ref = createAgentAccountStatusRef();
    ref.set("suspended");
    expect(ref.hasSynced()).toBe(true);
    expect(ref.get()).toBe("suspended");
  });

  test("set(null) marks synced with no account", () => {
    const ref = createAgentAccountStatusRef();
    ref.set(null);
    expect(ref.hasSynced()).toBe(true);
    expect(ref.get()).toBeNull();
  });
});
