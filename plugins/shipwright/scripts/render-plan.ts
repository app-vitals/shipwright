#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/render-plan.ts
 *
 * Parses a Shipwright PLAN.md or PRODUCT-SPEC.md markdown file into structured
 * PlanData and feeds it to the PV-1.1 HTML template (renderPlanHtml). Emits a
 * self-contained HTML document to stdout (default) or a file (--out).
 *
 * Parsing is intentionally defensive: missing or oddly-formatted sections
 * degrade to sensible empty defaults rather than throwing — render what is
 * present, skip the rest.
 *
 * Usage:
 *   bun plugins/shipwright/scripts/render-plan.ts --file PLAN.md --type plan
 *   bun plugins/shipwright/scripts/render-plan.ts --file SPEC.md --type spec --session "My Spec"
 *   bun plugins/shipwright/scripts/render-plan.ts --file PLAN.md --type plan --out /tmp/plan.html
 *
 * Args:
 *   --file <path>      (required) markdown file to parse
 *   --type plan|spec   (required) parse mode
 *   --session <slug>   override the derived session/title
 *   --repo <name>      override the derived repo
 *   --out <path>       write HTML to a file instead of stdout
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Clock, SystemClock } from "./clock.ts";
import {
  type PlanData,
  type PlanTask,
  renderPlanHtml,
} from "./render-plan-html.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MarkdownSection {
  heading: string;
  level: number;
  body: string;
}

export interface ParseOptions {
  session?: string;
  repo?: string;
}

type TableRow = Record<string, string>;

// ---------------------------------------------------------------------------
// Section parser
// ---------------------------------------------------------------------------

/**
 * Split markdown into sections keyed by ATX heading. Content before the first
 * heading is dropped. Tolerant of CRLF and leading/trailing whitespace.
 */
export function parseSections(md: string): MarkdownSection[] {
  if (!md) return [];

  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection | null = null;
  const bodyLines: string[] = [];

  const flush = () => {
    if (current) {
      current.body = bodyLines.join("\n").trim();
      sections.push(current);
    }
    bodyLines.length = 0;
  };

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      flush();
      current = {
        level: match[1].length,
        heading: match[2].trim(),
        body: "",
      };
    } else if (current) {
      bodyLines.push(line);
    }
  }
  flush();

  return sections;
}

/** Find the first section whose heading matches a predicate. */
function findSection(
  sections: MarkdownSection[],
  predicate: (heading: string) => boolean,
): MarkdownSection | undefined {
  return sections.find((s) => predicate(s.heading));
}

/** First non-empty prose paragraph in a block (skips lists, tables, fences). */
function firstParagraph(body: string): string {
  if (!body) return "";
  const blocks = body.split(/\n\s*\n/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const first = trimmed.split("\n")[0].trim();
    // Skip list items, tables, blockquotes, and fenced code.
    if (/^([-*+]|\d+\.|\||>|```)/.test(first)) continue;
    return trimmed.replace(/\s*\n\s*/g, " ");
  }
  return "";
}

/** Extract bullet/numbered list items as plain text (strips markers + bold). */
function listItems(body: string): string[] {
  if (!body) return [];
  const items: string[] = [];
  for (const raw of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    const match = /^(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (!match) continue;
    const text = match[1].replace(/\*\*/g, "").trim();
    if (text) items.push(text);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Markdown table parser
// ---------------------------------------------------------------------------

function splitTableRow(line: string): string[] {
  // Trim the optional leading/trailing pipe, then split on the rest.
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isSeparatorRow(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
}

/**
 * Parse a GitHub-flavoured markdown table into row objects keyed by the header
 * cell name. Columns are matched by NAME, so order/count may vary. Rows with
 * fewer cells than the header get empty strings for the missing columns; extra
 * cells are ignored. Returns [] for non-tables or header-only tables.
 */
export function parseMarkdownTable(block: string): TableRow[] {
  if (!block) return [];

  const lines = block
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("|"));

  if (lines.length < 2) return [];

  const headers = splitTableRow(lines[0]);
  if (headers.length === 0 || headers.every((h) => h === "")) return [];

  const rows: TableRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (isSeparatorRow(lines[i])) continue;
    const cells = splitTableRow(lines[i]);
    const row: TableRow = {};
    headers.forEach((header, idx) => {
      if (header) row[header] = cells[idx] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

/** Case-insensitive lookup of a column value across candidate header names. */
function pick(row: TableRow, ...names: string[]): string {
  const lowerMap = new Map<string, string>();
  for (const [key, value] of Object.entries(row)) {
    lowerMap.set(key.toLowerCase(), value);
  }
  for (const name of names) {
    const hit = lowerMap.get(name.toLowerCase());
    if (hit !== undefined) return hit;
  }
  return "";
}

const NO_DEP = new Set(["", "-", "—", "–", "n/a", "none"]);

function parseDeps(raw: string): string[] {
  if (!raw || NO_DEP.has(raw.trim().toLowerCase())) return [];
  return raw
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d && !NO_DEP.has(d.toLowerCase()));
}

function parseHours(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// parsePlan
// ---------------------------------------------------------------------------

/** Parse a PLAN.md document into PlanData. Defensive throughout. */
export function parsePlan(md: string, opts: ParseOptions = {}): PlanData {
  const source = (md ?? "").replace(/\r\n/g, "\n");
  const sections = parseSections(source);

  // session ← slug after "# Plan:" (override via opts)
  const planMatch = /^#\s+Plan:\s*(.+)$/m.exec(source);
  const session = opts.session ?? planMatch?.[1].trim() ?? "";

  // repo ← the "Repo:" line value (override via opts)
  const repoMatch = /^Repo:\s*(.+)$/m.exec(source);
  const repo = opts.repo ?? repoMatch?.[1].trim() ?? "";

  // description ← first prose paragraph under "## Technical Design"
  const design = findSection(sections, (h) => /technical design/i.test(h));
  const description = design ? firstParagraph(design.body) : "";

  // tasks ← rows of the "## Task Table" section
  const taskSection = findSection(sections, (h) => /task table/i.test(h));
  const tasks: PlanTask[] = taskSection
    ? parseMarkdownTable(taskSection.body).map((row) => ({
        id: pick(row, "ID"),
        title: pick(row, "Title"),
        layer: pick(row, "Layer"),
        dependencies: parseDeps(pick(row, "Deps", "Dependencies")),
        hours: parseHours(pick(row, "Hours", "Hrs")),
        status: "pending",
        model: pick(row, "Model"),
      }))
    : [];

  // keyDecisions ← bullets of a "Key Decisions" section, if present
  const decisions = findSection(sections, (h) => /key decisions/i.test(h));
  const keyDecisions = decisions ? listItems(decisions.body) : [];

  return {
    session,
    repo,
    date: today(),
    description,
    tasks,
    keyDecisions,
  };
}

// ---------------------------------------------------------------------------
// parseSpec
// ---------------------------------------------------------------------------

/** Parse a PRODUCT-SPEC.md document into PlanData (no task table). */
export function parseSpec(md: string, opts: ParseOptions = {}): PlanData {
  const source = (md ?? "").replace(/\r\n/g, "\n");
  const sections = parseSections(source);

  // session ← the "# {Title}" heading (override via opts)
  const h1 = sections.find((s) => s.level === 1);
  const session = opts.session ?? h1?.heading ?? "";

  // repo ← opts only (specs carry no Repo: line)
  const repo = opts.repo ?? "";

  // description ← first prose paragraph of a Problem/Context section
  const problem = findSection(sections, (h) => /problem|context/i.test(h));
  const description = problem ? firstParagraph(problem.body) : "";

  // keyDecisions ← items of the Goals section (excluding Non-Goals)
  const goals = findSection(
    sections,
    (h) => /goals/i.test(h) && !/non-?goals/i.test(h),
  );
  const keyDecisions = goals ? listItems(goals.body) : [];

  return {
    session,
    repo,
    date: today(),
    description,
    tasks: [],
    keyDecisions,
  };
}

// ---------------------------------------------------------------------------
// Upload + local-open — injectable dependencies (mirrors the Clock pattern)
// ---------------------------------------------------------------------------

/**
 * Minimal `fetch`-shaped HTTP client. We only use what we need: the production
 * default delegates to the real global `fetch`, and tests inject a recorder so
 * we never touch the network or override `global.fetch`.
 */
export type HttpClient = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/** Production HTTP client — the real `fetch`, narrowed to our shape. */
const systemHttpClient: HttpClient = (url, init) =>
  fetch(url, init as RequestInit);

/** Environment descriptor used for local-open context detection. */
export interface OpenEnv {
  platform: NodeJS.Platform | string;
  isTTY: boolean;
  /** Value of `$DISPLAY` (only meaningful on linux). */
  display: string;
}

/**
 * Decide whether to attempt a local browser open. True only in an interactive
 * desktop context: a TTY must be present AND a display must be available.
 *  - darwin: a TTY is sufficient (no X display concept).
 *  - linux:  a TTY plus a non-empty $DISPLAY.
 *  - otherwise (cloud / Slack / CI): false — just print the URL.
 */
export function shouldOpenLocally(env: OpenEnv): boolean {
  if (!env.isTTY) return false;
  if (env.platform === "darwin") return true;
  if (env.platform === "linux") return env.display.trim().length > 0;
  return false;
}

/** The OS-native open command, or null when none is known. */
export function openCommand(platform: NodeJS.Platform | string): string | null {
  if (platform === "darwin") return "open";
  if (platform === "linux") return "xdg-open";
  return null;
}

/** Spawn function shape — production delegates to detached child_process spawn. */
export type SpawnFn = (command: string, args: string[]) => void;

/** Production spawn: detached + unref so opening never blocks the CLI. */
const systemSpawn: SpawnFn = (command, args) => {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
};

/**
 * Best-effort local browser open. Never throws and never blocks — gated on
 * {@link shouldOpenLocally} and a known {@link openCommand}.
 */
export function maybeOpenLocally(
  target: string,
  env: OpenEnv,
  spawnFn: SpawnFn = systemSpawn,
): void {
  if (!shouldOpenLocally(env)) return;
  const cmd = openCommand(env.platform);
  if (!cmd) return;
  try {
    spawnFn(cmd, [target]);
  } catch {
    // Opening is a convenience; swallow any failure.
  }
}

/** Dependencies for {@link uploadDoc} — all injectable for tests. */
export interface UploadDeps {
  fetch: HttpClient;
  /** `$SHIPWRIGHT_TASK_STORE_URL` (undefined when unset). */
  url: string | undefined;
  /** `$SHIPWRIGHT_TASK_STORE_TOKEN` (undefined when unset). */
  token: string | undefined;
  clock: Clock;
}

/** Write the HTML to a temp file and return its absolute path. */
function writeTempHtml(html: string, clock: Clock): string {
  const stamp = clock.now().toISOString().replace(/[:.]/g, "-");
  const path = join(tmpdir(), `shipwright-plan-${stamp}.html`);
  writeFileSync(path, html, "utf-8");
  return path;
}

/**
 * Upload the rendered HTML to the task store `/docs` endpoint and return the
 * absolute shareable URL. On ANY failure — env vars unset, network error,
 * non-2xx status, unparseable body, or a missing `url` field — fall back to
 * writing a local temp file and return THAT path instead. Never throws.
 */
export async function uploadDoc(
  html: string,
  deps: UploadDeps,
): Promise<string | null> {
  const { url, token, clock } = deps;

  // Single fallback path for every failure mode. Returns the temp-file path, or
  // null only if even the temp write fails — keeping the `string | null`
  // contract honest so callers can dump HTML to stdout as a last resort.
  const fallback = (): string | null => {
    try {
      return writeTempHtml(html, clock);
    } catch {
      return null;
    }
  };

  // Env vars unset → skip upload entirely, go straight to temp-file fallback.
  if (!url || !token) return fallback();

  try {
    const endpoint = `${url.replace(/\/$/, "")}/docs`;
    const res = await deps.fetch(endpoint, {
      method: "POST",
      // Raw HTML string — the server reads it via `c.req.text()`.
      headers: { Authorization: `Bearer ${token}` },
      body: html,
    });
    if (!res.ok) return fallback();
    const parsed = (await res.json()) as { url?: unknown };
    if (typeof parsed.url !== "string" || parsed.url.length === 0) {
      return fallback();
    }
    return parsed.url;
  } catch {
    return fallback();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  file?: string;
  type?: string;
  session?: string;
  repo?: string;
  out?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--file":
        args.file = value;
        i++;
        break;
      case "--type":
        args.type = value;
        i++;
        break;
      case "--session":
        args.session = value;
        i++;
        break;
      case "--repo":
        args.repo = value;
        i++;
        break;
      case "--out":
        args.out = value;
        i++;
        break;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.file) {
    process.stderr.write("error: --file <path> is required\n");
    process.exit(2);
  }
  if (args.type !== "plan" && args.type !== "spec") {
    process.stderr.write("error: --type must be 'plan' or 'spec'\n");
    process.exit(2);
  }

  const md = readFileSync(args.file, "utf-8");
  const opts: ParseOptions = { session: args.session, repo: args.repo };
  const plan =
    args.type === "plan" ? parsePlan(md, opts) : parseSpec(md, opts);
  const html = renderPlanHtml(plan);

  if (args.out) {
    // Preserve the original --out behavior unchanged: write the file, notice
    // on stderr, no upload.
    writeFileSync(args.out, html, "utf-8");
    process.stderr.write(`render-plan: wrote ${args.out}\n`);
    return;
  }

  // No --out: upload the HTML and surface a shareable URL. Output convention —
  // human-facing notices go to stderr; the final shareable URL (or temp-file
  // path on fallback) goes to stdout so callers can capture it cleanly. The
  // upload/open path is fully defensive and never throws, so it cannot change
  // the parse/render exit-code behavior above.
  const url = process.env.SHIPWRIGHT_TASK_STORE_URL;
  const token = process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
  const envUnset = !url || !token;

  const result = await uploadDoc(html, {
    fetch: systemHttpClient,
    url,
    token,
    clock: SystemClock(),
  });

  if (result === null) {
    // Defensive: uploadDoc only returns null on a temp-write failure we cannot
    // recover from. Fall back to stdout so the HTML is never lost.
    process.stdout.write(html);
    return;
  }

  const isHostedUrl = /^https?:\/\//.test(result);
  if (isHostedUrl) {
    maybeOpenLocally(result, {
      platform: process.platform,
      isTTY: Boolean(process.stdout.isTTY),
      display: process.env.DISPLAY ?? "",
    });
  } else {
    // Single notice for the local-file outcome. When the env vars are unset we
    // surface the reason here rather than emitting a separate upfront line, so
    // one event produces exactly one stderr notice.
    const reason = envUnset
      ? " (SHIPWRIGHT_TASK_STORE_URL/TOKEN unset)"
      : "";
    process.stderr.write(`render-plan: wrote local file ${result}${reason}\n`);
  }
  process.stdout.write(`${result}\n`);
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    process.stderr.write(
      `error: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(1);
  });
}
