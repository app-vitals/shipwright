/**
 * scripts/chat.unit.test.ts
 * Unit tests for the pure (I/O-free) parts of the TUI chat client.
 *
 * Covers the request builder, the response formatter, and the friendly
 * unreachable-agent error helper. No socket, no live server, no global
 * overrides — the REPL loop's fetch seam is injectable but not exercised here.
 */

import { describe, expect, test } from "bun:test";
import {
  buildChatRequest,
  formatChatResponse,
  formatUnreachableError,
} from "./chat.ts";

describe("buildChatRequest", () => {
  test("defaults to http://localhost:3000/chat", () => {
    const { url } = buildChatRequest("hi", "sess-1");
    expect(url).toBe("http://localhost:3000/chat");
  });

  test("respects an explicit base URL", () => {
    const { url } = buildChatRequest("hi", "sess-1", "http://example.com:4000");
    expect(url).toBe("http://example.com:4000/chat");
  });

  test("handles a trailing slash on the base URL", () => {
    const { url } = buildChatRequest("hi", "sess-1", "http://example.com:4000/");
    expect(url).toBe("http://example.com:4000/chat");
  });

  test("uses POST with a JSON content-type", () => {
    const { init } = buildChatRequest("hi", "sess-1");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("body parses back to { message, session }", () => {
    const { init } = buildChatRequest("hello there", "sess-42");
    const parsed = JSON.parse(init.body as string);
    expect(parsed).toEqual({ message: "hello there", session: "sess-42" });
  });
});

describe("formatChatResponse", () => {
  test("returns the result text", () => {
    expect(formatChatResponse({ result: "done." })).toBe("done.");
  });

  test("trims trailing whitespace", () => {
    expect(formatChatResponse({ result: "hi\n\n  " })).toBe("hi");
  });

  test("handles a missing result", () => {
    expect(formatChatResponse({})).toBe("(no response)");
  });

  test("handles an empty result", () => {
    expect(formatChatResponse({ result: "   " })).toBe("(no response)");
  });
});

describe("formatUnreachableError", () => {
  test("produces a one-line, stack-free message including the URL and a hint", () => {
    const msg = formatUnreachableError(
      "http://localhost:3000/chat",
      new TypeError("fetch failed"),
    );
    expect(msg).toContain("http://localhost:3000/chat");
    expect(msg).toContain("AGENT_URL");
    expect(msg.includes("\n")).toBe(false);
    expect(msg).not.toContain(".stack");
  });

  test("never leaks a stack trace even when the error carries one", () => {
    const err = new Error("boom");
    const msg = formatUnreachableError("http://localhost:3000/chat", err);
    expect(err.stack).toBeDefined();
    expect(msg).not.toContain(err.stack as string);
  });
});
