/**
 * agent/src/chat-guard.unit.test.ts
 *
 * Unit tests for the dev-chat doctor guard predicate.
 * Pure logic over an injected env object — no process.env reads, no I/O.
 */

import { describe, expect, it } from "bun:test";
import { devChatGuardViolation } from "./chat-guard.ts";

describe("devChatGuardViolation", () => {
  it("returns a violation reason when SHIPWRIGHT_DEV_CHAT=true in production", () => {
    const reason = devChatGuardViolation({
      SHIPWRIGHT_DEV_CHAT: "true",
      NODE_ENV: "production",
    });
    expect(reason).toBeString();
    expect(reason).toContain("SHIPWRIGHT_DEV_CHAT");
  });

  it("returns null when SHIPWRIGHT_DEV_CHAT=true but NOT production", () => {
    expect(
      devChatGuardViolation({
        SHIPWRIGHT_DEV_CHAT: "true",
        NODE_ENV: "development",
      }),
    ).toBeNull();
  });

  it("returns null in production when the flag is unset", () => {
    expect(devChatGuardViolation({ NODE_ENV: "production" })).toBeNull();
  });

  it("returns null in production when the flag is explicitly false", () => {
    expect(
      devChatGuardViolation({
        SHIPWRIGHT_DEV_CHAT: "false",
        NODE_ENV: "production",
      }),
    ).toBeNull();
  });

  it("returns null when both flag and NODE_ENV are unset", () => {
    expect(devChatGuardViolation({})).toBeNull();
  });
});
