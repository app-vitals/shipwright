/**
 * Unit tests for parseMarkers() in agent/src/markers.ts
 *
 * Pure function — no side effects, no mocks needed.
 */

import { describe, expect, test } from "bun:test";
import { parseMarkers } from "./markers.ts";

// ─── [silent] ─────────────────────────────────────────────────────────────────

describe("[silent] marker", () => {
  test("detects [silent] and returns silent marker", () => {
    const { markers } = parseMarkers("[silent]");
    expect(markers).toHaveLength(1);
    expect(markers[0].type).toBe("silent");
  });

  test("strips [silent] from cleaned text", () => {
    const { cleaned } = parseMarkers("[silent]");
    expect(cleaned).toBe("");
  });

  test("[silent] in middle does NOT trigger silent marker", () => {
    const { cleaned, markers } = parseMarkers("before [silent] after");
    expect(markers.some((m) => m.type === "silent")).toBe(false);
    expect(cleaned).toBe("before [silent] after");
  });

  test("[silent] at end triggers silent marker and strips it", () => {
    const { cleaned, markers } = parseMarkers("All done.\n[silent]");
    expect(markers.some((m) => m.type === "silent")).toBe(true);
    expect(cleaned).toBe("All done.");
  });

  test("[silent] at start without trailing position is NOT silent", () => {
    const { markers } = parseMarkers("[silent] but also text");
    expect(markers.some((m) => m.type === "silent")).toBe(false);
  });

  test("[silent] with trailing whitespace still triggers silent", () => {
    const { markers } = parseMarkers("[silent]   \n  ");
    expect(markers.some((m) => m.type === "silent")).toBe(true);
  });

  test("is case-insensitive", () => {
    const { markers } = parseMarkers("[SILENT]");
    expect(markers.some((m) => m.type === "silent")).toBe(true);
  });

  test("text without [silent] has no silent marker", () => {
    const { markers } = parseMarkers("Hello world");
    expect(markers.some((m) => m.type === "silent")).toBe(false);
  });
});

// ─── [upload:...] ─────────────────────────────────────────────────────────────

describe("[upload:...] marker", () => {
  test("parses a file path", () => {
    const { markers, cleaned } = parseMarkers(
      "See attached [upload:/tmp/report.pdf]",
    );
    const uploadMarker = markers.find((m) => m.type === "upload");
    expect(uploadMarker).toBeDefined();
    expect((uploadMarker as { type: "upload"; path: string }).path).toBe(
      "/tmp/report.pdf",
    );
    expect(cleaned).toBe("See attached");
  });

  test("parses multiple upload markers", () => {
    const { markers } = parseMarkers("[upload:/tmp/a.pdf][upload:/tmp/b.png]");
    const uploads = markers.filter((m) => m.type === "upload") as {
      type: "upload";
      path: string;
    }[];
    expect(uploads).toHaveLength(2);
    expect(uploads[0].path).toBe("/tmp/a.pdf");
    expect(uploads[1].path).toBe("/tmp/b.png");
  });

  test("strips upload marker from cleaned text", () => {
    const { cleaned } = parseMarkers("Done [upload:/tmp/out.csv]");
    expect(cleaned).not.toContain("[upload:");
  });

  test("malformed upload with empty path is left in text", () => {
    const { cleaned, markers } = parseMarkers("[upload:]");
    expect(cleaned).toContain("[upload:]");
    expect(markers.some((m) => m.type === "upload")).toBe(false);
  });

  test("malformed upload with whitespace-only path is left in text", () => {
    const { cleaned, markers } = parseMarkers("[upload:   ]");
    expect(cleaned).toContain("[upload:   ]");
    expect(markers.some((m) => m.type === "upload")).toBe(false);
  });
});

// ─── [plan:url] ───────────────────────────────────────────────────────────────

describe("[plan:url] marker", () => {
  test("detects [plan:url] and returns plan marker with url", () => {
    const { markers } = parseMarkers(
      "Plan ready [plan:https://example.com/p/abc]",
    );
    const planMarker = markers.find((m) => m.type === "plan");
    expect(planMarker).toBeDefined();
    if (planMarker?.type === "plan") {
      expect(planMarker.url).toBe("https://example.com/p/abc");
    }
  });

  test("strips [plan:url] from cleaned text", () => {
    const { cleaned } = parseMarkers("Done [plan:https://example.com/p/abc]");
    expect(cleaned).toBe("Done");
    expect(cleaned).not.toContain("[plan:");
  });

  test("malformed [plan:] with empty url is left in text and yields no marker", () => {
    const { cleaned, markers } = parseMarkers("[plan:]");
    expect(markers.some((m) => m.type === "plan")).toBe(false);
    expect(cleaned).toContain("[plan:]");
  });

  test("[plan:url] mid-text is still parsed (markers can appear anywhere)", () => {
    const { cleaned, markers } = parseMarkers(
      "before [plan:https://example.com/p/xyz] after",
    );
    const planMarker = markers.find((m) => m.type === "plan");
    expect(planMarker).toBeDefined();
    if (planMarker?.type === "plan") {
      expect(planMarker.url).toBe("https://example.com/p/xyz");
    }
    expect(cleaned).toBe("before  after");
  });
});

// ─── Multiple markers ─────────────────────────────────────────────────────────

describe("multiple markers in one response", () => {
  test("parses upload + speak together", () => {
    const { markers, cleaned } = parseMarkers(
      "Here is the report [upload:/tmp/report.pdf][speak:report ready]",
    );
    expect(markers.some((m) => m.type === "upload")).toBe(true);
    expect(markers.some((m) => m.type === "speak")).toBe(true);
    expect(cleaned).toBe("Here is the report");
  });

  test("silent with other markers — silent must be at end", () => {
    const { markers } = parseMarkers("[upload:/tmp/out.txt][silent]");
    expect(markers.some((m) => m.type === "silent")).toBe(true);
    expect(markers.some((m) => m.type === "upload")).toBe(true);
  });

  test("no text remaining when all content is markers", () => {
    const { cleaned } = parseMarkers("[silent]");
    expect(cleaned).toBe("");
  });
});

// ─── No markers ───────────────────────────────────────────────────────────────

describe("no markers", () => {
  test("returns unchanged text when no markers present", () => {
    const input = "Just a plain response with no markers.";
    const { cleaned, markers } = parseMarkers(input);
    expect(cleaned).toBe(input);
    expect(markers).toHaveLength(0);
  });

  test("returns empty string for empty input", () => {
    const { cleaned, markers } = parseMarkers("");
    expect(cleaned).toBe("");
    expect(markers).toHaveLength(0);
  });
});

// ─── [speak:...] ──────────────────────────────────────────────────────────────

describe("[speak:text] marker", () => {
  test("parses [speak:text] and returns speak marker", () => {
    const { markers } = parseMarkers("[speak:Hello there]");
    expect(markers).toHaveLength(1);
    expect(markers[0].type).toBe("speak");
    if (markers[0].type === "speak") {
      expect(markers[0].text).toBe("Hello there");
    }
  });

  test("strips [speak:text] from cleaned text", () => {
    const { cleaned } = parseMarkers("Response text [speak:Hello there]");
    expect(cleaned).toBe("Response text");
  });

  test("handles multi-word speak text", () => {
    const { markers } = parseMarkers("[speak:The answer is 42, my friend]");
    expect(markers[0].type).toBe("speak");
    if (markers[0].type === "speak") {
      expect(markers[0].text).toBe("The answer is 42, my friend");
    }
  });

  test("malformed [speak:] with empty text — left in cleaned text", () => {
    const { cleaned, markers } = parseMarkers("[speak:]");
    expect(markers.some((m) => m.type === "speak")).toBe(false);
    expect(cleaned).toContain("[speak:]");
  });

  test("speak with surrounding text preserves other content", () => {
    const { cleaned, markers } = parseMarkers(
      "Here is my answer. [speak:Here is my answer]",
    );
    expect(cleaned).toBe("Here is my answer.");
    expect(markers.some((m) => m.type === "speak")).toBe(true);
  });
});

// ─── [react:...] ──────────────────────────────────────────────────────────────

describe("[react:emoji] marker", () => {
  test("parses single emoji and returns react marker", () => {
    const { markers } = parseMarkers("Nice work! [react:thumbsup]");
    const reactMarker = markers.find((m) => m.type === "react");
    expect(reactMarker).toBeDefined();
    if (reactMarker?.type === "react") {
      expect(reactMarker.emojis).toEqual(["thumbsup"]);
    }
  });

  test("strips [react:emoji] from cleaned text", () => {
    const { cleaned } = parseMarkers("Done [react:white_check_mark]");
    expect(cleaned).toBe("Done");
    expect(cleaned).not.toContain("[react:");
  });

  test("parses comma-separated emojis", () => {
    const { markers } = parseMarkers("[react:thumbsup,tada]");
    const reactMarker = markers.find((m) => m.type === "react");
    expect(reactMarker).toBeDefined();
    if (reactMarker?.type === "react") {
      expect(reactMarker.emojis).toEqual(["thumbsup", "tada"]);
    }
  });

  test("parses three emojis", () => {
    const { markers } = parseMarkers("All good [react:thumbsup,tada,rocket]");
    const reactMarker = markers.find((m) => m.type === "react");
    if (reactMarker?.type === "react") {
      expect(reactMarker.emojis).toEqual(["thumbsup", "tada", "rocket"]);
    }
  });

  test("trims whitespace from emoji names", () => {
    const { markers } = parseMarkers("[react: thumbsup , tada ]");
    const reactMarker = markers.find((m) => m.type === "react");
    if (reactMarker?.type === "react") {
      expect(reactMarker.emojis).toEqual(["thumbsup", "tada"]);
    }
  });

  test("malformed [react:] with empty content is left in text", () => {
    const { cleaned, markers } = parseMarkers("[react:]");
    expect(markers.some((m) => m.type === "react")).toBe(false);
    expect(cleaned).toContain("[react:]");
  });

  test("react marker coexists with other markers", () => {
    const { markers, cleaned } = parseMarkers("Done [react:thumbsup][silent]");
    expect(markers.some((m) => m.type === "react")).toBe(true);
    expect(markers.some((m) => m.type === "silent")).toBe(true);
    expect(cleaned).toBe("Done");
  });
});
