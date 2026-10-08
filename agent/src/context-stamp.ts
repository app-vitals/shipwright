/**
 * agent/src/context-stamp.ts
 *
 * Fingerprints the markdown Claude Code loads into every session from the
 * agent's workspace — the workspace `CLAUDE.md`, the files it `@`-imports,
 * and every `.claude/rules/*.md` without a `paths:` frontmatter (path-scoped
 * rules load on demand and are excluded) — plus the plugin version, since
 * the plugin's skill listing is also part of the always-loaded context.
 *
 * The resulting `contextFingerprint` is stamped onto each cron run so token
 * and outcome series can be grouped by *what the model was given*, not by
 * when a change merged. Two runs with the same fingerprint saw the same
 * always-loaded text; a CLAUDE.md edit produces a new fingerprint and the
 * prompt-audit patrol reads the before/after series by that key.
 *
 * Pure core (`computeContextStamp`) with injected file access; the
 * production reader (`createContextStampReader`) wraps `node:fs` and is
 * cheap enough to call once per run — the always-loaded set is a handful of
 * small files.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface RunContextStamp {
  /** First 12 hex chars of sha256 over the always-loaded set + plugin version. */
  contextFingerprint: string;
  pluginVersion: string | null;
  claudeCodeVersion: string | null;
}

export interface ContextStampDeps {
  /** Workspace root — the cwd Claude Code is spawned in. */
  workspace: string;
  /** Returns file contents, or null when the file is missing/unreadable. */
  readFile: (absPath: string) => string | null;
  /** Lists `.md` files (absolute paths) under `<workspace>/.claude/rules`, recursively. */
  listRuleFiles: () => string[];
  pluginVersion: () => string | null;
  claudeCodeVersion: () => string | null;
}

/** Fenced code blocks and inline code spans are skipped by Claude Code's import parser. */
const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const IMPORT_RE = /(?:^|\s)@((?:\\ |[^\s`])+)/g;

/** Extracts `@path` imports the way Claude Code resolves them (one hop, relative to the file). */
export function extractImports(content: string): string[] {
  const stripped = content.replace(FENCE_RE, "").replace(INLINE_CODE_RE, "");
  const out: string[] = [];
  for (const m of stripped.matchAll(IMPORT_RE)) {
    const raw = m[1];
    if (!raw) continue;
    // Email-ish tokens ("user@host") never match because the regex requires
    // whitespace or line start before the "@"; strip trailing punctuation.
    const cleaned = raw.replace(/\\ /g, " ").replace(/[.,;:)]+$/, "");
    if (cleaned.length > 0) out.push(cleaned);
  }
  return out;
}

/** True when the rule file's YAML frontmatter declares a `paths:` key (on-demand rule). */
export function hasPathsFrontmatter(content: string): boolean {
  if (!content.startsWith("---")) return false;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return false;
  const frontmatter = content.slice(3, end);
  return /^\s*paths\s*:/m.test(frontmatter);
}

export function computeContextStamp(deps: ContextStampDeps): RunContextStamp {
  const hash = createHash("sha256");
  const claudeMdPath = join(deps.workspace, "CLAUDE.md");
  const claudeMd = deps.readFile(claudeMdPath);
  hash.update("CLAUDE.md\0");
  hash.update(claudeMd ?? "");
  hash.update("\0");

  if (claudeMd !== null) {
    for (const rel of extractImports(claudeMd)) {
      const abs = resolve(deps.workspace, rel);
      hash.update(`import:${rel}\0`);
      hash.update(deps.readFile(abs) ?? "");
      hash.update("\0");
    }
  }

  const rules = deps
    .listRuleFiles()
    .map((abs) => ({ abs, content: deps.readFile(abs) }))
    .filter(
      (r): r is { abs: string; content: string } =>
        r.content !== null && !hasPathsFrontmatter(r.content),
    )
    .sort((a, b) => (a.abs < b.abs ? -1 : a.abs > b.abs ? 1 : 0));
  for (const rule of rules) {
    hash.update(`rule:${rule.abs.slice(deps.workspace.length)}\0`);
    hash.update(rule.content);
    hash.update("\0");
  }

  const pluginVersion = deps.pluginVersion();
  hash.update(`plugin:${pluginVersion ?? ""}\0`);

  return {
    contextFingerprint: hash.digest("hex").slice(0, 12),
    pluginVersion,
    claudeCodeVersion: deps.claudeCodeVersion(),
  };
}

/**
 * Fail-soft wrapper: any error from the injected deps (unreadable rules dir,
 * throwing version probe) yields `null` — an unstamped run — never a throw.
 */
export function tryComputeContextStamp(
  deps: ContextStampDeps,
): RunContextStamp | null {
  try {
    return computeContextStamp(deps);
  } catch {
    return null;
  }
}

function listMarkdownRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) out.push(...listMarkdownRecursive(abs));
    else if (entry.endsWith(".md")) out.push(abs);
  }
  return out;
}

function readFileOrNull(absPath: string): string | null {
  try {
    return readFileSync(absPath, "utf-8");
  } catch {
    return null;
  }
}

/** Reads `version` from a plugin.json / package.json-shaped file, or null. */
export function readVersionFile(absPath: string): string | null {
  const raw = readFileOrNull(absPath);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export interface ContextStampReaderOptions {
  workspace: string;
  /** Path to the shipwright plugin's `plugin.json` (its `version` is the plugin version). */
  pluginJsonPath: string;
  claudeCodeVersion: () => string | null;
}

/**
 * Production reader: `node:fs`-backed `computeContextStamp`. Never throws —
 * a missing workspace or plugin manifest just fingerprints as empty, and any
 * unexpected read error yields `null` (unstamped).
 */
export function createContextStampReader(
  opts: ContextStampReaderOptions,
): () => RunContextStamp | null {
  return () =>
    tryComputeContextStamp({
      workspace: opts.workspace,
      readFile: readFileOrNull,
      listRuleFiles: () =>
        listMarkdownRecursive(join(opts.workspace, ".claude", "rules")),
      pluginVersion: () => readVersionFile(opts.pluginJsonPath),
      claudeCodeVersion: opts.claudeCodeVersion,
    });
}
