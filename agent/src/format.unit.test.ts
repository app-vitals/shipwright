/**
 * Tests for agent/src/format.ts
 * markdownToSlack: pure function, no mocking needed.
 *
 * Note on conversion order:
 * The pipeline is: tables → headings(*) → bold(*) → italic(*→_) → code → links → hr
 * Headings and **bold** are first wrapped in *, then the italic pass converts *x* → _x_.
 * So headings and bold both render as _italic_ style in Slack (Slack italic = bold in some clients).
 */

import { describe, expect, test } from "bun:test";
import { markdownToBlocks, markdownToSlack } from "./format.ts";

describe("markdownToSlack", () => {
  // ─── Headings (become _italic_ due to conversion order) ───────────────────

  test("converts h1 heading — wraps in underscores (italic)", () => {
    expect(markdownToSlack("# Hello World")).toBe("_Hello World_");
  });

  test("converts h2 heading — wraps in underscores", () => {
    expect(markdownToSlack("## Section Title")).toBe("_Section Title_");
  });

  test("converts h6 heading — wraps in underscores", () => {
    expect(markdownToSlack("###### Deep Heading")).toBe("_Deep Heading_");
  });

  // ─── Bold (also becomes _italic_ due to conversion order) ─────────────────

  test("converts **bold** — becomes _underscored_ in Slack", () => {
    expect(markdownToSlack("This is **bold** text")).toBe(
      "This is _bold_ text",
    );
  });

  test("handles multiple **bold** spans", () => {
    expect(markdownToSlack("**first** and **second**")).toBe(
      "_first_ and _second_",
    );
  });

  // ─── Italic ────────────────────────────────────────────────────────────────

  test("converts *italic* to _italic_", () => {
    expect(markdownToSlack("This is *italic* text")).toBe(
      "This is _italic_ text",
    );
  });

  // ─── Inline code ───────────────────────────────────────────────────────────

  test("preserves inline code backticks unchanged", () => {
    expect(markdownToSlack("Use `npm install` to install")).toBe(
      "Use `npm install` to install",
    );
  });

  // ─── Links ─────────────────────────────────────────────────────────────────

  test("converts [text](url) to Slack <url|text> format", () => {
    expect(markdownToSlack("[Click here](https://example.com)")).toBe(
      "<https://example.com|Click here>",
    );
  });

  test("handles multiple links", () => {
    const input = "[A](https://a.com) and [B](https://b.com)";
    expect(markdownToSlack(input)).toBe(
      "<https://a.com|A> and <https://b.com|B>",
    );
  });

  // ─── Horizontal rules ──────────────────────────────────────────────────────

  test("converts --- to unicode line", () => {
    expect(markdownToSlack("---")).toBe("─────────────────────");
  });

  test("converts longer --- to unicode line", () => {
    expect(markdownToSlack("------")).toBe("─────────────────────");
  });

  // ─── Tables (require tight separators like |---|---| without spaces) ───────

  test("converts markdown table with tight separator to code block", () => {
    const table = "| Name | Value |\n|---|---|\n| foo | bar |\n";
    const result = markdownToSlack(table);
    expect(result).toContain("```");
    expect(result).toContain("| Name | Value |");
    expect(result).toContain("| foo | bar |");
  });

  test("converts markdown table with spaced separator | --- | --- |", () => {
    const table = "| Name | Value |\n| --- | --- |\n| foo | bar |\n";
    const result = markdownToSlack(table);
    expect(result).toContain("```");
    expect(result).toContain("| Name | Value |");
    expect(result).toContain("| foo | bar |");
  });

  // ─── Trim ──────────────────────────────────────────────────────────────────

  test("trims leading and trailing whitespace", () => {
    expect(markdownToSlack("  hello  ")).toBe("hello");
  });

  // ─── Combined ──────────────────────────────────────────────────────────────

  test("handles multi-line message with heading, bold, and link", () => {
    const input = [
      "# Report",
      "",
      "This is **important** information.",
      "See [docs](https://docs.example.com) for details.",
    ].join("\n");

    const result = markdownToSlack(input);
    expect(result).toContain("_Report_");
    expect(result).toContain("_important_");
    expect(result).toContain("<https://docs.example.com|docs>");
  });

  test("passes through plain text unchanged", () => {
    expect(markdownToSlack("plain text with no markdown")).toBe(
      "plain text with no markdown",
    );
  });

  test("empty string returns empty string", () => {
    expect(markdownToSlack("")).toBe("");
  });
});

describe("markdownToBlocks", () => {
  test("returns null when no table is present", () => {
    expect(markdownToBlocks("just some *bold* text")).toBeNull();
  });

  test("builds a table block from a markdown table", () => {
    const result = markdownToBlocks(
      "| Name | Value |\n|---|---|\n| foo | bar |\n",
    );
    expect(result).not.toBeNull();
    const table = result?.blocks.find((b) => b.type === "table") as
      | { type: "table"; rows: Array<Array<{ type: string; text: string }>> }
      | undefined;
    expect(table).toBeDefined();
    expect(table?.rows).toEqual([
      [
        { type: "raw_text", text: "Name" },
        { type: "raw_text", text: "Value" },
      ],
      [
        { type: "raw_text", text: "foo" },
        { type: "raw_text", text: "bar" },
      ],
    ]);
  });

  test("coerces an empty corner/header cell to a non-empty placeholder (Slack rejects 0-char cells)", () => {
    // Blank leading header cell — a common markdown table shape that previously
    // produced text: "" and failed Slack with invalid_blocks.
    const result = markdownToBlocks(
      "|  | Col A | Col B |\n|---|---|---|\n| Row 1 | x | y |\n",
    );
    const table = result?.blocks.find((b) => b.type === "table") as
      | { type: "table"; rows: Array<Array<{ type: string; text: string }>> }
      | undefined;
    expect(table).toBeDefined();
    const allCells = table?.rows.flat() ?? [];
    // No cell may have empty text.
    expect(allCells.every((c) => c.text.length > 0)).toBe(true);
    // The blank corner cell specifically became the placeholder.
    expect(table?.rows[0][0]).toEqual({ type: "raw_text", text: " " });
  });
});
