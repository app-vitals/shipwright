/**
 * Tests for agent/src/format.ts
 * markdownToSlack: pure function, no mocking needed.
 *
 * Note on conversion order:
 * The pipeline is: tables → italic(*→_) → headings(*) → bold(**→*) → code → links → hr
 * The italic pass runs first (on the original markdown) so that the lookbehind/lookahead
 * can distinguish *italic* from **bold**. Headings and **bold** become *text* (Slack bold),
 * while *italic* becomes _text_ (Slack italic).
 */

import { describe, expect, test } from "bun:test";
import {
  formatPlanLink,
  markdownToBlocks,
  markdownToSlack,
  richTextToMarkdown,
} from "./format.ts";

describe("markdownToSlack", () => {
  // ─── Headings (become *bold* in Slack) ────────────────────────────────────

  test("converts h1 heading — wraps in asterisks (Slack bold)", () => {
    expect(markdownToSlack("# Hello World")).toBe("*Hello World*");
  });

  test("converts h2 heading — wraps in asterisks", () => {
    expect(markdownToSlack("## Section Title")).toBe("*Section Title*");
  });

  test("converts h6 heading — wraps in asterisks", () => {
    expect(markdownToSlack("###### Deep Heading")).toBe("*Deep Heading*");
  });

  // ─── Bold (becomes *bold* in Slack) ───────────────────────────────────────

  test("converts **bold** — becomes *bold* in Slack", () => {
    expect(markdownToSlack("This is **bold** text")).toBe(
      "This is *bold* text",
    );
  });

  test("handles multiple **bold** spans", () => {
    expect(markdownToSlack("**first** and **second**")).toBe(
      "*first* and *second*",
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
    expect(result).toContain("*Report*");
    expect(result).toContain("*important*");
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

describe("richTextToMarkdown", () => {
  // ─── Empty / no-op inputs ─────────────────────────────────────────────────

  test("empty array returns empty string", () => {
    expect(richTextToMarkdown([])).toBe("");
  });

  test("array with no rich_text block returns empty string", () => {
    expect(richTextToMarkdown([{ type: "section", text: "hello" }])).toBe("");
  });

  test("null and non-object entries in blocks array are ignored, not thrown", () => {
    expect(
      richTextToMarkdown([
        null,
        "not an object",
        42,
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "hello" }],
            },
          ],
        },
      ]),
    ).toBe("hello");
  });

  // ─── Plain text section ───────────────────────────────────────────────────

  test("plain text section returns the text", () => {
    expect(
      richTextToMarkdown([
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "hello" }],
            },
          ],
        },
      ]),
    ).toBe("hello");
  });

  // ─── Inline text style flags ──────────────────────────────────────────────

  test("bold text wrapped in **", () => {
    expect(
      richTextToMarkdown([
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "bold", style: { bold: true } }],
            },
          ],
        },
      ]),
    ).toBe("**bold**");
  });

  test("italic text wrapped in *", () => {
    expect(
      richTextToMarkdown([
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "italic", style: { italic: true } },
              ],
            },
          ],
        },
      ]),
    ).toBe("*italic*");
  });

  test("code text wrapped in backticks", () => {
    expect(
      richTextToMarkdown([
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "code", style: { code: true } }],
            },
          ],
        },
      ]),
    ).toBe("`code`");
  });

  test("strikethrough text wrapped in ~~", () => {
    expect(
      richTextToMarkdown([
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "text", text: "strike", style: { strike: true } },
              ],
            },
          ],
        },
      ]),
    ).toBe("~~strike~~");
  });

  // ─── Preformatted ─────────────────────────────────────────────────────────

  test("preformatted block produces fenced code block", () => {
    expect(
      richTextToMarkdown([
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_preformatted",
              elements: [{ type: "text", text: "code here" }],
            },
          ],
        },
      ]),
    ).toBe("```\ncode here\n```");
  });

  // ─── Lists ────────────────────────────────────────────────────────────────

  test("bullet list produces - items", () => {
    expect(
      richTextToMarkdown([
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_list",
              style: "bullet",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: "item1" }],
                },
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: "item2" }],
                },
              ],
            },
          ],
        },
      ]),
    ).toBe("- item1\n- item2");
  });

  test("ordered list produces numbered items", () => {
    expect(
      richTextToMarkdown([
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_list",
              style: "ordered",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: "item1" }],
                },
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: "item2" }],
                },
              ],
            },
          ],
        },
      ]),
    ).toBe("1. item1\n2. item2");
  });

  // ─── Link elements ────────────────────────────────────────────────────────

  test("link with text renders as [text](url)", () => {
    expect(
      richTextToMarkdown([
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "link", text: "click", url: "https://example.com" },
              ],
            },
          ],
        },
      ]),
    ).toBe("[click](https://example.com)");
  });

  test("link without text renders as bare url", () => {
    expect(
      richTextToMarkdown([
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "link", url: "https://example.com" }],
            },
          ],
        },
      ]),
    ).toBe("https://example.com");
  });

  // ─── Emoji and user mention ───────────────────────────────────────────────

  test("emoji element renders as :name:", () => {
    expect(
      richTextToMarkdown([
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "emoji", name: "wave" }],
            },
          ],
        },
      ]),
    ).toBe(":wave:");
  });

  test("user element renders as <@user_id>", () => {
    expect(
      richTextToMarkdown([
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "user", user_id: "U123" }],
            },
          ],
        },
      ]),
    ).toBe("<@U123>");
  });

  // ─── Multiple sections joined by newlines ─────────────────────────────────

  test("multiple rich_text_sections joined by blank line (paragraph break)", () => {
    expect(
      richTextToMarkdown([
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "line one" }],
            },
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "line two" }],
            },
          ],
        },
      ]),
    ).toBe("line one\n\nline two");
  });

  // ─── Quote ────────────────────────────────────────────────────────────────

  test("rich_text_quote renders as blockquote", () => {
    expect(
      richTextToMarkdown([
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_quote",
              elements: [{ type: "text", text: "quoted text" }],
            },
          ],
        },
      ]),
    ).toBe("> quoted text");
  });

  test("rich_text_quote with embedded newlines prefixes every line with >", () => {
    expect(
      richTextToMarkdown([
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_quote",
              elements: [{ type: "text", text: "line one\nline two" }],
            },
          ],
        },
      ]),
    ).toBe("> line one\n> line two");
  });

  // ─── Combined block ───────────────────────────────────────────────────────

  test("combined block: section + preformatted + list", () => {
    expect(
      richTextToMarkdown([
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "intro" }],
            },
            {
              type: "rich_text_preformatted",
              elements: [{ type: "text", text: "code block" }],
            },
            {
              type: "rich_text_list",
              style: "bullet",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: "item" }],
                },
              ],
            },
          ],
        },
      ]),
    ).toBe("intro\n\n```\ncode block\n```\n\n- item");
  });
});

describe("formatPlanLink", () => {
  const url = "https://example.com/p/abc";

  test("returns exactly one section block", () => {
    const { blocks } = formatPlanLink(url);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("section");
  });

  test("section mrkdwn contains the url and 'View plan'", () => {
    const { blocks } = formatPlanLink(url);
    const block = blocks[0] as {
      type: "section";
      text: { type: "mrkdwn"; text: string };
    };
    expect(block.text.type).toBe("mrkdwn");
    expect(block.text.text).toContain(url);
    expect(block.text.text).toContain("View plan");
  });

  test("fallback text contains the url", () => {
    const { text } = formatPlanLink(url);
    expect(text).toContain(url);
  });
});
