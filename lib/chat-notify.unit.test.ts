import { describe, expect, test } from "bun:test";
import {
  type ReplyNotificationEvent,
  parseReplyNotificationEvent,
} from "./chat-notify.ts";

describe("parseReplyNotificationEvent — valid shapes", () => {
  test("parses a full event with a string title", () => {
    const input = { threadId: "thread-1", agentId: "agent-1", title: "Hi" };
    const result = parseReplyNotificationEvent(input);
    expect(result).toEqual({
      threadId: "thread-1",
      agentId: "agent-1",
      title: "Hi",
    } satisfies ReplyNotificationEvent);
  });

  test("parses an event with a null title", () => {
    const input = { threadId: "thread-1", agentId: "agent-1", title: null };
    const result = parseReplyNotificationEvent(input);
    expect(result).toEqual({
      threadId: "thread-1",
      agentId: "agent-1",
      title: null,
    });
  });
});

describe("parseReplyNotificationEvent — invalid shapes", () => {
  test("rejects null", () => {
    expect(parseReplyNotificationEvent(null)).toBeNull();
  });

  test("rejects a non-object", () => {
    expect(parseReplyNotificationEvent("not an object")).toBeNull();
  });

  test("rejects a missing threadId", () => {
    expect(
      parseReplyNotificationEvent({ agentId: "agent-1", title: null }),
    ).toBeNull();
  });

  test("rejects a missing agentId", () => {
    expect(
      parseReplyNotificationEvent({ threadId: "thread-1", title: null }),
    ).toBeNull();
  });

  test("rejects a non-string threadId", () => {
    expect(
      parseReplyNotificationEvent({
        threadId: 123,
        agentId: "agent-1",
        title: null,
      }),
    ).toBeNull();
  });

  test("rejects a non-string agentId", () => {
    expect(
      parseReplyNotificationEvent({
        threadId: "thread-1",
        agentId: 123,
        title: null,
      }),
    ).toBeNull();
  });

  test("rejects a non-string, non-null title", () => {
    expect(
      parseReplyNotificationEvent({
        threadId: "thread-1",
        agentId: "agent-1",
        title: 42,
      }),
    ).toBeNull();
  });

  test("rejects a missing title field", () => {
    expect(
      parseReplyNotificationEvent({
        threadId: "thread-1",
        agentId: "agent-1",
      }),
    ).toBeNull();
  });
});
