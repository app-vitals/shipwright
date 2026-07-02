// Markdown → Slack mrkdwn converter
// Converts GitHub-flavored markdown to Slack format

const TABLE_REGEX =
  /(\|[^\n]+\|\n)([ \t]*\|[ \t]*[-:]+[ \t]*(?:\|[ \t]*[-:]+[ \t]*)*\|[ \t]*\n)((?:[ \t]*\|[^\n]+\|\n?)*)/gm;

export function markdownToSlack(text: string): string {
  return (
    text
      // Tables → code blocks (fallback for non-block contexts)
      .replace(TABLE_REGEX, (match) => {
        return `\`\`\`\n${match.trimEnd()}\n\`\`\``;
      })
      // Italic (but not bold) — must run before heading/bold so the
      // lookbehind/lookahead can distinguish *italic* from **bold** in
      // the original markdown input. After the bold pass, **bold** becomes
      // *bold* and the regex would incorrectly convert it to _bold_ (italic).
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "_$1_")
      // Headings → bold
      .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
      // Bold
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      // Inline code
      .replace(/`([^`]+)`/g, "`$1`")
      // Links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>")
      // Horizontal rules
      .replace(/^---+$/gm, "─────────────────────")
      .trim()
  );
}

const SECTION_TEXT_LIMIT = 3000;

type RawTextCell = { type: "raw_text"; text: string };
type TableBlock = {
  type: "table";
  column_settings: Array<{ align: "left" | "center" | "right" }>;
  rows: RawTextCell[][];
};
type SectionBlock = { type: "section"; text: { type: "mrkdwn"; text: string } };
export type SlackBlock = TableBlock | SectionBlock;

function pushSectionBlocks(blocks: SlackBlock[], mrkdwn: string): void {
  if (!mrkdwn) return;
  for (let i = 0; i < mrkdwn.length; i += SECTION_TEXT_LIMIT) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: mrkdwn.slice(i, i + SECTION_TEXT_LIMIT) },
    });
  }
}

function parseTableRows(tableStr: string): string[][] {
  const lines = tableStr.trim().split("\n").filter(Boolean);
  const parseRow = (line: string) =>
    line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
  // lines[0] = header, lines[1] = separator, lines[2+] = data rows
  return [parseRow(lines[0]), ...lines.slice(2).map(parseRow)];
}

/**
 * Converts markdown to Slack Block Kit blocks when tables are present.
 * Returns null when no tables are found (fall back to markdownToSlack).
 */
export function markdownToBlocks(
  text: string,
): { text: string; blocks: SlackBlock[] } | null {
  const regex = new RegExp(TABLE_REGEX.source, TABLE_REGEX.flags);
  if (!regex.test(text)) return null;

  regex.lastIndex = 0;
  const blocks: SlackBlock[] = [];
  let lastIndex = 0;

  for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
    const before = text.slice(lastIndex, match.index).trim();
    if (before) {
      pushSectionBlocks(blocks, markdownToSlack(before));
    }

    const rows = parseTableRows(match[0]);
    const columnCount = rows[0]?.length ?? 0;
    blocks.push({
      type: "table",
      column_settings: Array.from({ length: columnCount }, () => ({
        align: "left" as const,
      })),
      rows: rows.map((row) =>
        // Slack's table block rejects a cell whose text is empty ("must be more
        // than 0 characters"), which a blank corner/header cell produces and
        // fails the whole message with invalid_blocks. Coerce empties to a
        // non-breaking space: a real character (passes validation) that still
        // renders blank.
        row.map((cell) => ({
          type: "raw_text" as const,
          text: cell || " ",
        })),
      ),
    });

    lastIndex = match.index + match[0].length;
  }

  const after = text.slice(lastIndex).trim();
  if (after) {
    pushSectionBlocks(blocks, markdownToSlack(after));
  }

  return { text: markdownToSlack(text), blocks };
}

// ─── Slack rich_text → Markdown ──────────────────────────────────────────────

type TextStyle = {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
};

type RichTextElement =
  | { type: "text"; text: string; style?: TextStyle }
  | { type: "link"; url: string; text?: string }
  | { type: "emoji"; name: string }
  | { type: "user"; user_id: string }
  | { type: string; [key: string]: unknown };

type RichTextSection = {
  type: "rich_text_section";
  elements: RichTextElement[];
};

type RichTextPreformatted = {
  type: "rich_text_preformatted";
  elements: RichTextElement[];
};

type RichTextList = {
  type: "rich_text_list";
  style: "bullet" | "ordered";
  elements: RichTextSection[];
};

type RichTextQuote = {
  type: "rich_text_quote";
  elements: RichTextElement[];
};

type RichTextBlockElement =
  | RichTextSection
  | RichTextPreformatted
  | RichTextList
  | RichTextQuote
  | { type: string; [key: string]: unknown };

type RichTextBlock = {
  type: "rich_text";
  elements: RichTextBlockElement[];
};

function convertInlineElement(el: RichTextElement): string {
  if (el.type === "text") {
    const style = el.style ?? {};
    let text = el.text;
    if (style.code) text = `\`${text}\``;
    if (style.bold) text = `**${text}**`;
    if (style.italic) text = `*${text}*`;
    if (style.strike) text = `~~${text}~~`;
    return text;
  }
  if (el.type === "link") {
    return el.text ? `[${el.text}](${el.url})` : el.url;
  }
  if (el.type === "emoji") {
    return `:${el.name}:`;
  }
  if (el.type === "user") {
    return `<@${el.user_id}>`;
  }
  return "";
}

function convertSection(section: RichTextSection): string {
  return section.elements.map(convertInlineElement).join("");
}

function convertRichTextBlock(block: RichTextBlock): string {
  const parts: string[] = [];

  for (const el of block.elements) {
    if (el.type === "rich_text_section") {
      parts.push(convertSection(el as RichTextSection));
    } else if (el.type === "rich_text_preformatted") {
      const pre = el as RichTextPreformatted;
      const inner = pre.elements.map(convertInlineElement).join("");
      parts.push(`\`\`\`\n${inner}\n\`\`\``);
    } else if (el.type === "rich_text_list") {
      const list = el as RichTextList;
      const items = list.elements.map((item, i) => {
        const text = convertSection(item);
        return list.style === "ordered" ? `${i + 1}. ${text}` : `- ${text}`;
      });
      parts.push(items.join("\n"));
    } else if (el.type === "rich_text_quote") {
      const quote = el as RichTextQuote;
      const inner = quote.elements.map(convertInlineElement).join("");
      parts.push(`> ${inner}`);
    }
  }

  return parts.join("\n");
}

/**
 * Converts Slack rich_text blocks to markdown.
 * Walks the blocks array for any `{type: "rich_text"}` block and converts
 * its elements to markdown. Returns empty string if no rich_text block found.
 */
export function richTextToMarkdown(blocks: unknown[]): string {
  const richBlocks = (blocks as Array<{ type: string }>).filter(
    (b) => b.type === "rich_text",
  ) as RichTextBlock[];

  if (richBlocks.length === 0) return "";

  return richBlocks.map(convertRichTextBlock).join("\n");
}

/**
 * Builds a Slack message for a shareable plan/spec link: a single mrkdwn
 * section block (`<url|View plan>`, the Slack link form `markdownToSlack`
 * emits) plus a plain-text fallback. Used by the [plan:url] response marker.
 */
export function formatPlanLink(url: string): {
  text: string;
  blocks: SlackBlock[];
} {
  return {
    text: `View plan: ${url}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `<${url}|View plan>` },
      },
    ],
  };
}
