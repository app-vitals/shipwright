/**
 * admin/src/http-chat-client.unit.test.ts
 * Pure unit tests for the read-side helpers in http-chat-client.ts.
 */

import { describe, expect, test } from "bun:test";
import { type ChatMessage, filterSince } from "./http-chat-client.ts";

function msg(id: string): ChatMessage {
  return {
    id,
    threadId: "t",
    role: "user",
    body: id,
    createdAt: "2024-01-01T00:00:00.000Z",
    claimedBy: null,
    repliedAt: null,
    tokens: null,
    costUsd: null,
    errorKind: null,
    attachmentFilename: null,
    attachmentSize: null,
  };
}

describe("filterSince (CFB-2.3 incremental ?since polling)", () => {
  const messages = [msg("a"), msg("b"), msg("c"), msg("d")];

  test("returns only messages after the given id", () => {
    expect(filterSince(messages, "b").map((m) => m.id)).toEqual(["c", "d"]);
  });

  test("returns empty when since is the last message", () => {
    expect(filterSince(messages, "d")).toEqual([]);
  });

  test("returns the full list when the since id is not found (re-sync)", () => {
    expect(filterSince(messages, "zzz").map((m) => m.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  test("returns everything after the first when since is the first id", () => {
    expect(filterSince(messages, "a").map((m) => m.id)).toEqual([
      "b",
      "c",
      "d",
    ]);
  });
});
