/**
 * scripts/chat.unit.test.ts
 * Unit tests for pure functions in scripts/chat.ts.
 *
 * Pure logic only — no I/O, no network, no live server.
 * No mock.module(), no global.fetch overrides (Bun shares the test process;
 * leaked globals break sibling suites).
 */

import { describe, expect, test } from "bun:test";
import {
  buildChatRequest,
  formatAgentResponse,
  formatFetchError,
  formatHttpError,
} from "./chat.ts";

// ---------------------------------------------------------------------------
// buildChatRequest
// ---------------------------------------------------------------------------

describe("buildChatRequest", () => {
  test("returns body with message only when no session provided", () => {
    const body = buildChatRequest("hello");
    expect(body).toEqual({ message: "hello" });
    expect("session" in body).toBe(false);
  });

  test("returns body with message and session when session is provided", () => {
    const body = buildChatRequest("hello", "conv-1");
    expect(body).toEqual({ message: "hello", session: "conv-1" });
  });

  test("omits session when empty string is passed", () => {
    const body = buildChatRequest("hello", "");
    expect(body).toEqual({ message: "hello" });
    expect("session" in body).toBe(false);
  });

  test("omits session when undefined is passed", () => {
    const body = buildChatRequest("world", undefined);
    expect(body).toEqual({ message: "world" });
    expect("session" in body).toBe(false);
  });

  test("preserves the message string verbatim", () => {
    const msg = "  spaces and\ttabs  ";
    const body = buildChatRequest(msg, "s");
    expect(body.message).toBe(msg);
  });
});

// ---------------------------------------------------------------------------
// formatAgentResponse
// ---------------------------------------------------------------------------

describe("formatAgentResponse", () => {
  test("prepends 'agent> ' to the result", () => {
    expect(formatAgentResponse("Hello!")).toBe("agent> Hello!");
  });

  test("handles empty result string", () => {
    expect(formatAgentResponse("")).toBe("agent> ");
  });

  test("handles multi-line result", () => {
    const result = "line one\nline two";
    expect(formatAgentResponse(result)).toBe("agent> line one\nline two");
  });

  test("does not double-prefix if result already starts with agent>", () => {
    // The formatter is not responsible for detecting double-prefix — it just
    // applies its own prefix. This test documents that behavior.
    expect(formatAgentResponse("agent> already")).toBe("agent> agent> already");
  });
});

// ---------------------------------------------------------------------------
// formatFetchError
// ---------------------------------------------------------------------------

describe("formatFetchError", () => {
  test("TypeError → friendly 'Cannot reach agent' message", () => {
    const err = new TypeError("fetch failed");
    const msg = formatFetchError(err, "http://localhost:3000");
    expect(msg).toContain("Cannot reach agent");
    expect(msg).toContain("http://localhost:3000");
    expect(msg).toContain("SHIPWRIGHT_DEV_CHAT=true");
    // No stack trace — stack frames look like "    at <fn> (file:line)"
    expect(msg).not.toMatch(/\s{2,}at /u);
  });

  test("regular Error → 'Error: <message>'", () => {
    const err = new Error("non-2xx response: 500");
    const msg = formatFetchError(err, "http://localhost:3000");
    expect(msg).toContain("Error:");
    expect(msg).toContain("non-2xx response: 500");
    // No stack trace — stack frames look like "    at <fn> (file:line)"
    expect(msg).not.toMatch(/\s{2,}at /u);
  });

  test("non-Error thrown value → safe fallback message", () => {
    const msg = formatFetchError("something weird", "http://localhost:3000");
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
    // Should not throw or expose raw value directly as-is without context
    expect(msg).toContain("Error");
  });

  test("uses the provided url in TypeError message", () => {
    const err = new TypeError("fetch failed");
    const msg = formatFetchError(err, "http://example.com:9000");
    expect(msg).toContain("http://example.com:9000");
  });
});

// ---------------------------------------------------------------------------
// formatHttpError
// ---------------------------------------------------------------------------

describe("formatHttpError", () => {
  test("prefers the JSON body's `error` field over the status line", () => {
    const msg = formatHttpError(
      429,
      "Too Many Requests",
      JSON.stringify({
        error: "You've hit your Sonnet limit · resets 8pm (UTC)",
      }),
    );
    expect(msg).toBe(
      "agent error (429): You've hit your Sonnet limit · resets 8pm (UTC)",
    );
  });

  test("falls back to raw body text when the body is not JSON", () => {
    const msg = formatHttpError(
      500,
      "Internal Server Error",
      "plain text boom",
    );
    expect(msg).toBe("agent error (500): plain text boom");
  });

  test("falls back to statusText when the body is empty", () => {
    const msg = formatHttpError(502, "Bad Gateway", "");
    expect(msg).toBe("agent error (502): Bad Gateway");
  });

  test("falls back to raw body when JSON lacks a usable `error` field", () => {
    const msg = formatHttpError(
      500,
      "Internal Server Error",
      JSON.stringify({}),
    );
    expect(msg).toBe("agent error (500): {}");
  });

  test("includes the numeric status code", () => {
    const msg = formatHttpError(504, "Gateway Timeout", "");
    expect(msg).toContain("504");
  });
});
