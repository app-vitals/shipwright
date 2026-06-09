/**
 * agent/src/chat.unit.test.ts
 * Unit tests for the checkDevChatGuard predicate.
 *
 * Tests purely against the guard function — no Hono, no runner, no network.
 */

import { describe, expect, it } from "bun:test";
import { checkDevChatGuard } from "./chat.ts";

describe("checkDevChatGuard", () => {
  it("passes when SHIPWRIGHT_DEV_CHAT is not set", () => {
    const result = checkDevChatGuard({});
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("passes when SHIPWRIGHT_DEV_CHAT is empty string", () => {
    const result = checkDevChatGuard({ SHIPWRIGHT_DEV_CHAT: "" });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("fails when SHIPWRIGHT_DEV_CHAT is 'true'", () => {
    const result = checkDevChatGuard({ SHIPWRIGHT_DEV_CHAT: "true" });
    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe("string");
    expect((result.reason ?? "").length).toBeGreaterThan(0);
  });

  it("fails when SHIPWRIGHT_DEV_CHAT is any non-empty value", () => {
    const result = checkDevChatGuard({ SHIPWRIGHT_DEV_CHAT: "1" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("fails when SHIPWRIGHT_DEV_CHAT is 'false' (any non-empty value is truthy)", () => {
    // Even the string "false" is a non-empty value — the guard treats any set value as a problem
    const result = checkDevChatGuard({ SHIPWRIGHT_DEV_CHAT: "false" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("reason message mentions SHIPWRIGHT_DEV_CHAT", () => {
    const result = checkDevChatGuard({ SHIPWRIGHT_DEV_CHAT: "true" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("SHIPWRIGHT_DEV_CHAT");
  });
});
