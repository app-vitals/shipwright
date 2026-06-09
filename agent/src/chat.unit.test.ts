/** agent/src/chat.unit.test.ts — checkDevChatProductionGuard predicate. */

import { describe, expect, it } from "bun:test";
import { checkDevChatProductionGuard } from "./chat.ts";

describe("checkDevChatProductionGuard", () => {
  it("fails when SHIPWRIGHT_DEV_CHAT=true in NODE_ENV=production", () => {
    const result = checkDevChatProductionGuard({
      SHIPWRIGHT_DEV_CHAT: "true",
      NODE_ENV: "production",
    });
    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe("string");
    expect(result.reason?.length).toBeGreaterThan(0);
  });

  it("fails when SHIPWRIGHT_DEV_CHAT=true in SHIPWRIGHT_ENV=production", () => {
    const result = checkDevChatProductionGuard({
      SHIPWRIGHT_DEV_CHAT: "true",
      SHIPWRIGHT_ENV: "production",
    });
    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe("string");
  });

  it("passes when SHIPWRIGHT_DEV_CHAT=true in NODE_ENV=development", () => {
    const result = checkDevChatProductionGuard({
      SHIPWRIGHT_DEV_CHAT: "true",
      NODE_ENV: "development",
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("passes when SHIPWRIGHT_DEV_CHAT is unset in NODE_ENV=production", () => {
    const result = checkDevChatProductionGuard({
      NODE_ENV: "production",
    });
    expect(result.ok).toBe(true);
  });

  it("passes when SHIPWRIGHT_DEV_CHAT=false in NODE_ENV=production", () => {
    const result = checkDevChatProductionGuard({
      SHIPWRIGHT_DEV_CHAT: "false",
      NODE_ENV: "production",
    });
    expect(result.ok).toBe(true);
  });

  it("passes when neither env var is set", () => {
    const result = checkDevChatProductionGuard({});
    expect(result.ok).toBe(true);
  });

  it("passes when SHIPWRIGHT_DEV_CHAT=true but no production env indicator", () => {
    const result = checkDevChatProductionGuard({
      SHIPWRIGHT_DEV_CHAT: "true",
    });
    expect(result.ok).toBe(true);
  });
});
