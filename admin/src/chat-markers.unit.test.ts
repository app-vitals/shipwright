/**
 * admin/src/chat-markers.unit.test.ts
 * Unit tests for parseChatMarkers() — marker parsing for chat display.
 */

import { describe, expect, it } from "bun:test";
import { parseChatMarkers } from "./chat-markers.ts";

describe("parseChatMarkers", () => {
  it("returns cleaned text without [silent] marker", () => {
    const result = parseChatMarkers("Here is a response [silent]");
    expect(result.cleaned).not.toContain("[silent]");
    expect(result.cleaned).toContain("Here is a response");
  });

  it("extracts upload path from [upload:/path/to/file.pdf] marker", () => {
    const result = parseChatMarkers("Check the file [upload:/tmp/report.pdf]");
    expect(result.uploads).toContain("/tmp/report.pdf");
    expect(result.cleaned).not.toContain("[upload:");
  });

  it("extracts plan URL from [plan:https://example.com/plan] marker", () => {
    const result = parseChatMarkers("See the plan [plan:https://example.com/plan]");
    expect(result.planUrls).toContain("https://example.com/plan");
    expect(result.cleaned).not.toContain("[plan:");
  });

  it("strips [speak:text] marker from cleaned text", () => {
    const result = parseChatMarkers("Done [speak:all work complete]");
    expect(result.cleaned).not.toContain("[speak:");
    expect(result.cleaned).not.toContain("all work complete");
  });

  it("strips [react:emoji] marker from cleaned text", () => {
    const result = parseChatMarkers("Great work [react:thumbsup]");
    expect(result.cleaned).not.toContain("[react:");
    expect(result.cleaned).not.toContain("thumbsup");
  });

  it("handles multiple markers in one message", () => {
    const text =
      "Here is a response with multiple markers [upload:/tmp/file1.pdf] and [upload:/tmp/file2.pdf] plus [plan:https://example.com/plan] [react:eyes] [silent]";
    const result = parseChatMarkers(text);
    expect(result.uploads).toEqual(["/tmp/file1.pdf", "/tmp/file2.pdf"]);
    expect(result.planUrls).toEqual(["https://example.com/plan"]);
    expect(result.cleaned).not.toContain("[upload:");
    expect(result.cleaned).not.toContain("[plan:");
    expect(result.cleaned).not.toContain("[react:");
    expect(result.cleaned).not.toContain("[silent]");
  });

  it("handles text with no markers", () => {
    const text = "Just a normal message with no markers at all";
    const result = parseChatMarkers(text);
    expect(result.cleaned).toEqual(text);
    expect(result.uploads).toEqual([]);
    expect(result.planUrls).toEqual([]);
  });

  it("preserves cleaned text with markdown", () => {
    const text = "This is **bold** and `code` [upload:/tmp/file.pdf]";
    const result = parseChatMarkers(text);
    expect(result.cleaned).toContain("**bold**");
    expect(result.cleaned).toContain("`code`");
    expect(result.cleaned).not.toContain("[upload:");
  });

  it("trims whitespace after marker removal", () => {
    const text = "Message   [upload:/tmp/file.pdf]  ";
    const result = parseChatMarkers(text);
    expect(result.cleaned).not.toMatch(/\s+$/);
  });

  it("handles malformed markers gracefully", () => {
    const text = "Message with [upload:] empty marker";
    const result = parseChatMarkers(text);
    // Malformed markers should be left in the cleaned text
    expect(result.uploads.length).toBe(0);
  });

  it("handles empty input", () => {
    const result = parseChatMarkers("");
    expect(result.cleaned).toBe("");
    expect(result.uploads).toEqual([]);
    expect(result.planUrls).toEqual([]);
  });

  it("handles [silent] at end of line", () => {
    const text = "Final message [silent]";
    const result = parseChatMarkers(text);
    expect(result.cleaned).toBe("Final message");
    expect(result.cleaned).not.toContain("[silent]");
  });

  it("handles [silent] with trailing whitespace", () => {
    const text = "Final message [silent]   ";
    const result = parseChatMarkers(text);
    expect(result.cleaned).toBe("Final message");
  });

  it("returns arrays in order of occurrence", () => {
    const text =
      "[upload:/a.pdf] text [upload:/b.pdf] [plan:http://x] [plan:http://y]";
    const result = parseChatMarkers(text);
    expect(result.uploads).toEqual(["/a.pdf", "/b.pdf"]);
    expect(result.planUrls).toEqual(["http://x", "http://y"]);
  });

  it("does not extract non-http plan URLs (defense-in-depth against javascript: injection)", () => {
    const text = "See [plan:javascript:alert(1)] and [plan:https://safe.example.com]";
    const result = parseChatMarkers(text);
    // javascript: URL should not be extracted — left in text as-is
    expect(result.planUrls).toEqual(["https://safe.example.com"]);
    expect(result.cleaned).toContain("[plan:javascript:alert(1)]");
  });
});
