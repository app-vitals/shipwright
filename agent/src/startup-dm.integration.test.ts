/**
 * Integration tests for agent/src/startup-dm.ts
 *
 * Strategy: inject a typed mock WebClient — no mock.module(), no global overrides.
 * Covers all three branches:
 *  1. Happy path — conversations.open resolves with a valid channel.id → postMessage called
 *  2. No channel-id — channel.id undefined → postMessage NOT called, no error
 *  3. Slack API throws — caught, console.warn called, no crash
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { WebClient } from "@slack/web-api";
import { sendBackOnlineDm } from "./startup-dm.ts";

// ─── Mock WebClient factory ───────────────────────────────────────────────────

function makeMockSlack(overrides: {
  conversationsOpenResult?: Awaited<ReturnType<WebClient["conversations"]["open"]>>;
  conversationsOpenError?: Error;
  postMessageResult?: Awaited<ReturnType<WebClient["chat"]["postMessage"]>>;
} = {}) {
  const conversationsOpen = overrides.conversationsOpenError
    ? mock(async (_args: unknown) => { throw overrides.conversationsOpenError; })
    : mock(async (_args: unknown) =>
        overrides.conversationsOpenResult ?? { ok: true, channel: { id: "DM_CHAN_1" } },
      );

  const postMessage = mock(async (_args: unknown) => ({ ok: true, ts: "123.456" }));

  return {
    conversations: { open: conversationsOpen },
    chat: { postMessage },
  } as unknown as WebClient;
}

// ─── Capture console.warn ─────────────────────────────────────────────────────

let warnMessages: string[] = [];
const originalWarn = console.warn.bind(console);

beforeEach(() => {
  warnMessages = [];
  console.warn = (...args: unknown[]) => {
    warnMessages.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.warn = originalWarn;
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("sendBackOnlineDm — happy path", () => {
  test("opens a DM and posts 'back online' when channel.id is present", async () => {
    const slack = makeMockSlack();
    await sendBackOnlineDm(slack, "U12345");

    expect(slack.conversations.open).toHaveBeenCalledTimes(1);
    expect(slack.conversations.open).toHaveBeenCalledWith({ users: "U12345" });

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: "DM_CHAN_1",
      text: "back online",
    });

    expect(warnMessages.length).toBe(0);
  });
});

describe("sendBackOnlineDm — no-channel-id branch", () => {
  test("skips postMessage when conversations.open returns no channel.id", async () => {
    const slack = makeMockSlack({
      conversationsOpenResult: { ok: true, channel: { id: undefined } },
    });
    await sendBackOnlineDm(slack, "U12345");

    expect(slack.conversations.open).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(warnMessages.length).toBe(0);
  });

  test("skips postMessage when conversations.open returns null channel", async () => {
    const slack = makeMockSlack({
      // biome-ignore lint/suspicious/noExplicitAny: testing undefined channel path
      conversationsOpenResult: { ok: true, channel: null } as any,
    });
    await sendBackOnlineDm(slack, "U12345");

    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(warnMessages.length).toBe(0);
  });

  test("does nothing when ownerUser is undefined", async () => {
    const slack = makeMockSlack();
    await sendBackOnlineDm(slack, undefined);

    expect(slack.conversations.open).not.toHaveBeenCalled();
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(warnMessages.length).toBe(0);
  });

  test("does nothing when ownerUser is empty string", async () => {
    const slack = makeMockSlack();
    await sendBackOnlineDm(slack, "");

    expect(slack.conversations.open).not.toHaveBeenCalled();
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(warnMessages.length).toBe(0);
  });
});

describe("sendBackOnlineDm — error-caught branch", () => {
  test("catches Slack API error, warns, and does not crash", async () => {
    const slack = makeMockSlack({
      conversationsOpenError: new Error("channel_not_found"),
    });

    await expect(sendBackOnlineDm(slack, "U12345")).resolves.toBeUndefined();

    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    expect(warnMessages.length).toBe(1);
    expect(warnMessages[0]).toContain("back-online DM failed");
    expect(warnMessages[0]).toContain("channel_not_found");
  });

  test("warns with non-Error thrown value as string", async () => {
    const slack = {
      conversations: {
        open: mock(async (_args: unknown) => { throw "string-error"; }),
      },
      chat: { postMessage: mock(async (_args: unknown) => ({})) },
    } as unknown as WebClient;

    await expect(sendBackOnlineDm(slack, "U12345")).resolves.toBeUndefined();

    expect(warnMessages.length).toBe(1);
    expect(warnMessages[0]).toContain("string-error");
  });
});
