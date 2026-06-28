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
