/**
 * plugins/shipwright/scripts/prompt-audit/blast.ts
 *
 * Reverse-reference blast radius for a prompt file: who loads or pins it.
 * Reports referrers (CLAUDE.md, commands, skills, agents, @ imports, "see"
 * mentions), the manifest crons that invoke it and their loop phase, the
 * content tests whose assertions pin its wording, the docs-source-map pages
 * mapped to it, and its load class per context.
 *
 * Prose-based, so every report is a lower bound: a reference spelled in a way
 * the scan does not recognise is invisible to it.
 *
 * Pure core: all filesystem access goes through the injected `InventoryDeps`.
 */

import {
  type AuditContext,
  type InventoryDeps,
  type ItemKind,
  joinNormalized,
  type LoadClass,
  walkInventory,
} from "./inventory.ts";

export type ReferrerVia = "import" | "path" | "invoke";

export interface Referrer {
  path: string;
  kind: ItemKind;
  via: ReferrerVia;
  /** 1-based line of the first mention (0 for resolved @ imports). */
  line: number;
}

export interface CronInvoker {
  name: string;
  /** Loop phase (`dev-task`, `review`, ...) for crons dispatched by the loop. */
  loopPhase: string | null;
}

export interface PinningAssertion {
  line: number;
  text: string;
}

export interface PinningTest {
  file: string;
  assertions: PinningAssertion[];
}

export interface BlastReport {
  file: string;
  /** Always true: the scan is prose-based and cannot see every reference. */
  lowerBound: true;
  note: string;
  referrers: Referrer[];
  crons: CronInvoker[];
  pinningTests: PinningTest[];
  sourceMapPages: string[];
  loadClass: Record<AuditContext, LoadClass> | null;
}

export const LOWER_BOUND_NOTE =
  "Lower bound: derived from prose references, so mentions spelled in ways the scan does not recognise are not counted.";

const MANIFEST_RE = /(?:^|\/)agent-types\/[^/]+\/manifest\.yaml$/;
const CONTENT_TEST_RE = /\.content\.test\.[cm]?[jt]sx?$/;
const SOURCE_MAP_PATH = "site/docs-source-map.json";
const SKIP_SEGMENTS = new Set(["node_modules", ".git"]);
const LOOP_PARENT = "shipwright-loop";

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

/** Slash-command name a command/skill file is invoked as, if any. */
function invocationName(file: string): string | null {
  const cmd = /(?:^|\/)commands\/([^/]+)\.md$/.exec(file);
  if (cmd) return cmd[1];
  const skill = /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/.exec(file);
  return skill ? skill[1] : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()[\]\\|]/g, "\\$&");
}

/** First 1-based line of `text` matching any needle, or 0 when none match. */
function firstMentionLine(text: string, needles: RegExp[]): number {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (needles.some((re) => re.test(lines[i]))) return i + 1;
  }
  return 0;
}

/** Regexes that recognise a mention of `file` from a prompt living at `from`. */
function mentionPatterns(file: string, from: string): RegExp[] {
  const patterns = [new RegExp(`(?<![\\w./-])${escapeRe(file)}(?![\\w-])`)];
  const rel = relativeFrom(from, file);
  if (rel !== file) {
    patterns.push(new RegExp(`(?<![\\w/-])${escapeRe(rel)}(?![\\w-])`));
  }
  return patterns;
}

function relativeFrom(from: string, target: string): string {
  const fromParts = dirname(from) ? dirname(from).split("/") : [];
  const targetParts = target.split("/");
  let i = 0;
  while (
    i < fromParts.length &&
    i < targetParts.length - 1 &&
    fromParts[i] === targetParts[i]
  ) {
    i++;
  }
  const ups = fromParts.length - i;
  return [...Array(ups).fill(".."), ...targetParts.slice(i)].join("/");
}

function slashPattern(name: string): RegExp {
  return new RegExp(`/shipwright:${escapeRe(name)}(?![\\w-])`);
}

interface ManifestCron {
  name: string;
  prompt: string;
  parentCron: string | null;
}

/** Cron entries from a manifest's `crons:` list (flat `- name:` items). */
export function parseManifestCrons(manifest: string): ManifestCron[] {
  const crons: ManifestCron[] = [];
  let inCrons = false;
  let current: (ManifestCron & { block: boolean }) | null = null;
  const flush = () => {
    if (current) {
      const { block: _block, ...cron } = current;
      crons.push({ ...cron, prompt: cron.prompt.trim() });
    }
    current = null;
  };
  for (const line of manifest.split("\n")) {
    if (/^crons:\s*$/.test(line)) {
      inCrons = true;
      continue;
    }
    if (!inCrons) continue;
    if (/^\S/.test(line) && !line.startsWith("#")) break;
    const name = /^ {2}- name:\s*["']?([\w:.-]+)["']?\s*$/.exec(line);
    if (name) {
      flush();
      current = { name: name[1], prompt: "", parentCron: null, block: false };
      continue;
    }
    if (!current) continue;
    const field = /^ {4}([A-Za-z]+):\s*(.*)$/.exec(line);
    if (field) {
      current.block = false;
      const [, key, value] = field;
      if (key === "parentCron") current.parentCron = value.replace(/["']/g, "");
      if (key === "prompt") {
        if (/^[|>][+-]?$/.test(value)) current.block = true;
        else current.prompt = value.replace(/^["']|["']$/g, "");
      }
    } else if (current.block) {
      current.prompt += `${line.trim()}\n`;
    }
  }
  flush();
  return crons;
}

function loopPhase(cron: ManifestCron): string | null {
  if (cron.parentCron !== LOOP_PARENT) return null;
  return cron.name.replace(/^shipwright-/, "");
}

function findCrons(
  file: string,
  files: string[],
  deps: InventoryDeps,
  root: string,
): CronInvoker[] {
  const name = invocationName(file);
  const needles = [
    ...(name ? [slashPattern(name)] : []),
    ...mentionPatterns(file, ""),
  ];
  const out: CronInvoker[] = [];
  for (const manifest of files.filter((f) => MANIFEST_RE.test(f))) {
    for (const cron of parseManifestCrons(deps.readFile(root, manifest))) {
      if (needles.some((re) => re.test(cron.prompt))) {
        out.push({ name: cron.name, loopPhase: loopPhase(cron) });
      }
    }
  }
  return out;
}

const ASSERTION_RE = /\bexpect\(.*(?:["'`]|\/[^/]+\/[a-z]*\)|\bregex\b)/;

function findPinningTests(
  file: string,
  files: string[],
  deps: InventoryDeps,
  root: string,
): PinningTest[] {
  const stem = basename(file).replace(/\.[^.]+$/, "");
  const sibling = `${dirname(file) ? `${dirname(file)}/` : ""}${stem}.content.test.ts`;
  const out: PinningTest[] = [];
  for (const test of files.filter((f) => CONTENT_TEST_RE.test(f))) {
    const text = deps.readFile(root, test);
    const mentions =
      test === sibling ||
      firstMentionLine(text, mentionPatterns(file, test)) > 0 ||
      firstMentionLine(text, [new RegExp(`(?<![\\w.-])${escapeRe(basename(file))}(?![\\w-])`)]) > 0;
    if (!mentions) continue;
    const assertions: PinningAssertion[] = [];
    text.split("\n").forEach((line, i) => {
      if (ASSERTION_RE.test(line)) {
        assertions.push({ line: i + 1, text: line.trim() });
      }
    });
    if (assertions.length > 0) out.push({ file: test, assertions });
  }
  return out;
}

function findSourceMapPages(
  file: string,
  files: string[],
  deps: InventoryDeps,
  root: string,
): string[] {
  if (!files.includes(SOURCE_MAP_PATH)) return [];
  let map: Record<string, unknown>;
  try {
    map = JSON.parse(deps.readFile(root, SOURCE_MAP_PATH));
  } catch {
    return [];
  }
  const pages: string[] = [];
  for (const [page, sources] of Object.entries(map)) {
    if (page.startsWith("_") || !Array.isArray(sources)) continue;
    const hit = sources.some(
      (s) =>
        typeof s === "string" &&
        (s === file || (s.endsWith("/") ? file.startsWith(s) : file.startsWith(`${s}/`))),
    );
    if (hit) pages.push(page);
  }
  return pages.sort();
}

function findReferrers(
  file: string,
  deps: InventoryDeps,
  root: string,
): Referrer[] {
  const items = walkInventory(root, deps);
  const name = invocationName(file);
  const out: Referrer[] = [];
  for (const item of items) {
    if (item.path === file) continue;
    if (item.imports.includes(file)) {
      out.push({ path: item.path, kind: item.kind, via: "import", line: 0 });
      continue;
    }
    const text = deps.readFile(root, item.path);
    const pathLine = firstMentionLine(text, mentionPatterns(file, item.path));
    if (pathLine > 0) {
      out.push({ path: item.path, kind: item.kind, via: "path", line: pathLine });
      continue;
    }
    const invokeLine = name ? firstMentionLine(text, [slashPattern(name)]) : 0;
    if (invokeLine > 0) {
      out.push({ path: item.path, kind: item.kind, via: "invoke", line: invokeLine });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Who loads or pins `file` (root-relative posix path). */
export function blastRadius(
  file: string,
  root: string,
  deps: InventoryDeps,
): BlastReport {
  const target = joinNormalized("", file);
  const files = deps
    .listFiles(root)
    .filter((p) => !p.split("/").some((s) => SKIP_SEGMENTS.has(s)))
    .sort();
  const item = walkInventory(root, deps).find((i) => i.path === target);
  return {
    file: target,
    lowerBound: true,
    note: LOWER_BOUND_NOTE,
    referrers: findReferrers(target, deps, root),
    crons: findCrons(target, files, deps, root),
    pinningTests: findPinningTests(target, files, deps, root),
    sourceMapPages: findSourceMapPages(target, files, deps, root),
    loadClass: item?.loadClass ?? null,
  };
}
