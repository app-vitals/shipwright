#!/usr/bin/env bun
/**
 * scripts/prompt-trial-tally.ts
 *
 * Tallies prompt-variant trials from Claude Code session transcripts (DTA-9.4).
 * A session's variant is the `/shipwright:<name>` slash command in its first
 * user prompt, where <name> is --command or starts with `<command>-`
 * (e.g. dev-task vs dev-task-lean). Other sessions are ignored.
 *
 * Per variant it reports:
 *   (a) reference-file load rate: % of runs that loaded each
 *       `references/<name>/<file>` (seen in Read file_path or Bash command)
 *   (b) cost (USD, ESTIMATED) and turns (assistant messages) per run, mean and
 *       median, split main thread vs subagent
 *   (c) mean Agent dispatches per run, by subagent_type
 *
 * Subagent turns are lines with `isSidechain: true`, plus every line of
 * `<session>/subagents/*.jsonl` next to a session transcript.
 *
 * Usage:
 *   bun scripts/prompt-trial-tally.ts --command dev-task
 *     [--dir <transcripts dir>]... [--json]
 *   default dirs: every subdirectory of ~/.claude/projects
 *
 * Exit codes: 0 ok, 2 usage error.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Pricing (ESTIMATE - edit here). USD per million tokens, sonnet-5-5 style.
// Real billing differs (tiers, caching TTLs); a numeric `costUSD` on a
// transcript line overrides this table for that line.
// ---------------------------------------------------------------------------

export const PRICE_PER_MTOK = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 3.75,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface Split {
  main: number;
  sub: number;
}

export interface Transcript {
  sessionId?: string;
  /** Slash command name from the first user prompt, e.g. "dev-task-lean". */
  name?: string;
  turns: Split;
  cost: Split;
  /** "<dir>/<file>" for each references/<dir>/<file> seen. */
  refs: Set<string>;
  /** Agent tool_use counts by subagent_type. */
  dispatches: Record<string, number>;
}

export interface Stat {
  mean: number;
  median: number;
}

export interface VariantTally {
  variant: string;
  runs: number;
  refs: { ref: string; runs: number; rate: number }[];
  cost: { main: Stat; sub: Stat; total: Stat };
  turns: { main: Stat; sub: Stat; total: Stat };
  dispatch: { meanPerRun: number; bySubagent: Record<string, number> };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function costOf(usage: Usage | undefined, costUSD?: unknown): number {
  if (typeof costUSD === "number" && Number.isFinite(costUSD)) return costUSD;
  const u = usage ?? {};
  return (
    ((u.input_tokens ?? 0) * PRICE_PER_MTOK.input +
      (u.output_tokens ?? 0) * PRICE_PER_MTOK.output +
      (u.cache_read_input_tokens ?? 0) * PRICE_PER_MTOK.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * PRICE_PER_MTOK.cacheWrite) /
    1_000_000
  );
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const mean = (xs: number[]) =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
const stat = (xs: number[]): Stat => ({ mean: mean(xs), median: median(xs) });

const REF_RE = /references\/([\w-]+)\/([\w.-]+)/g;
const SLASH_RE = /\/shipwright:([\w-]+)/;

interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function promptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Block[])
      .map((b) => (b?.type === "text" ? (b.text ?? "") : ""))
      .join("\n");
  }
  return "";
}

/**
 * Parse one transcript's JSONL text. `forceSidechain` marks every line as a
 * subagent turn (used for `<session>/subagents/*.jsonl`). Malformed lines are
 * skipped.
 */
export function parseTranscript(text: string, forceSidechain = false): Transcript {
  const t: Transcript = {
    turns: { main: 0, sub: 0 },
    cost: { main: 0, sub: 0 },
    refs: new Set(),
    dispatches: {},
  };
  let sawPrompt = false;
  // Claude Code writes one JSONL line per content block, each repeating the
  // response's message.id and usage — count each response once.
  const counted = new Set<string>();
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let o: Record<string, any>;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    if (!t.sessionId && typeof o.sessionId === "string") t.sessionId = o.sessionId;
    const side = forceSidechain || o.isSidechain === true;
    const msg = o.message;
    const role = msg?.role ?? o.type;
    if (role === "user" && !side && !sawPrompt) {
      const body = promptText(msg?.content);
      if (body.trim()) {
        sawPrompt = true;
        t.name = SLASH_RE.exec(body)?.[1];
      }
      continue;
    }
    if (role !== "assistant" || !msg) continue;
    const k = side ? "sub" : "main";
    const id = typeof msg.id === "string" ? msg.id : undefined;
    if (!id || !counted.has(`${k}:${id}`)) {
      if (id) counted.add(`${k}:${id}`);
      t.turns[k]++;
      t.cost[k] += costOf(msg.usage, o.costUSD);
    }
    if (!Array.isArray(msg.content)) continue;
    for (const b of msg.content as Block[]) {
      if (b?.type !== "tool_use") continue;
      const input = b.input ?? {};
      if (b.name === "Agent") {
        const st = String(input.subagent_type ?? "general-purpose");
        t.dispatches[st] = (t.dispatches[st] ?? 0) + 1;
      }
      const hay =
        b.name === "Read"
          ? input.file_path
          : b.name === "Bash"
            ? input.command
            : undefined;
      if (typeof hay === "string") {
        for (const m of hay.matchAll(REF_RE)) t.refs.add(`${m[1]}/${m[2]}`);
      }
    }
  }
  return t;
}

/** Fold subagent-file transcripts into their parent session. */
export function mergeTranscripts(parent: Transcript, subs: Transcript[]): Transcript {
  for (const s of subs) {
    parent.turns.sub += s.turns.main + s.turns.sub;
    parent.cost.sub += s.cost.main + s.cost.sub;
    for (const r of s.refs) parent.refs.add(r);
    for (const [k, v] of Object.entries(s.dispatches)) {
      parent.dispatches[k] = (parent.dispatches[k] ?? 0) + v;
    }
  }
  return parent;
}

export function tallyVariants(sessions: Transcript[], command: string): VariantTally[] {
  const groups = new Map<string, Transcript[]>();
  for (const s of sessions) {
    if (!s.name) continue;
    if (s.name !== command && !s.name.startsWith(`${command}-`)) continue;
    groups.set(s.name, [...(groups.get(s.name) ?? []), s]);
  }
  return [...groups.entries()].map(([variant, runs]) => {
    const n = runs.length;
    const refCounts = new Map<string, number>();
    const disp: Record<string, number> = {};
    for (const r of runs) {
      for (const ref of r.refs) refCounts.set(ref, (refCounts.get(ref) ?? 0) + 1);
      for (const [k, v] of Object.entries(r.dispatches)) disp[k] = (disp[k] ?? 0) + v;
    }
    const split = (pick: (r: Transcript) => Split) => ({
      main: stat(runs.map((r) => pick(r).main)),
      sub: stat(runs.map((r) => pick(r).sub)),
      total: stat(runs.map((r) => pick(r).main + pick(r).sub)),
    });
    const bySubagent = Object.fromEntries(
      Object.entries(disp).map(([k, v]) => [k, v / n]),
    );
    return {
      variant,
      runs: n,
      refs: [...refCounts.entries()]
        .map(([ref, c]) => ({ ref, runs: c, rate: c / n }))
        .sort((a, b) => b.rate - a.rate || a.ref.localeCompare(b.ref)),
      cost: split((r) => r.cost),
      turns: split((r) => r.turns),
      dispatch: {
        meanPerRun: Object.values(bySubagent).reduce((a, b) => a + b, 0),
        bySubagent,
      },
    };
  }).sort((a, b) => a.variant.localeCompare(b.variant));
}

export function formatReport(tally: VariantTally[]): string {
  if (tally.length === 0) return "No matching sessions found.\n";
  const usd = (s: Stat) => `$${s.mean.toFixed(2)} / $${s.median.toFixed(2)}`;
  const num = (s: Stat) => `${s.mean.toFixed(1)} / ${s.median.toFixed(1)}`;
  const out: string[] = [];
  for (const v of tally) {
    out.push(`== ${v.variant}  (${v.runs} run${v.runs === 1 ? "" : "s"}) ==`);
    out.push("Reference load rate (% of runs):");
    if (v.refs.length === 0) out.push("  (none)");
    for (const r of v.refs) {
      out.push(
        `  ${r.ref.padEnd(48)} ${`${Math.round(r.rate * 100)}%`.padStart(5)}  (${r.runs}/${v.runs})`,
      );
    }
    out.push("Per run, mean / median  (cost is an ESTIMATE):");
    out.push(`  ${"".padEnd(10)} ${"cost".padEnd(20)} turns`);
    for (const k of ["main", "sub", "total"] as const) {
      out.push(
        `  ${k.padEnd(10)} ${usd(v.cost[k]).padEnd(20)} ${num(v.turns[k])}`,
      );
    }
    out.push(`Agent dispatches per run: ${v.dispatch.meanPerRun.toFixed(2)}`);
    for (const [k, c] of Object.entries(v.dispatch.bySubagent).sort()) {
      out.push(`  ${k.padEnd(30)} ${c.toFixed(2)}`);
    }
    out.push("");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface Args {
  command: string;
  dirs: string[];
  json: boolean;
}

export function parseArgs(argv: string[]): Args {
  let command: string | undefined;
  const dirs: string[] = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--command" || a === "--dir") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${a} requires a value`);
      if (a === "--command") command = v;
      else dirs.push(v);
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!command) throw new Error("--command is required");
  return { command, dirs, json };
}

function defaultDirs(): string[] {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((d) => join(root, d))
    .filter((p) => statSync(p).isDirectory());
}

/** Load every session transcript under dir (non-recursive into subagents/). */
export function loadSessions(dir: string): Transcript[] {
  if (!existsSync(dir)) return [];
  const out: Transcript[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const parent = parseTranscript(readFileSync(join(dir, f), "utf8"));
    const subDir = join(dir, f.slice(0, -".jsonl".length), "subagents");
    const subs = existsSync(subDir)
      ? readdirSync(subDir)
          .filter((s) => s.endsWith(".jsonl"))
          .map((s) => parseTranscript(readFileSync(join(subDir, s), "utf8"), true))
      : [];
    out.push(mergeTranscripts(parent, subs));
  }
  return out;
}

if (import.meta.main) {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    console.error(
      "usage: bun scripts/prompt-trial-tally.ts --command <name> [--dir <dir>]... [--json]",
    );
    process.exit(2);
  }
  const dirs = args.dirs.length ? args.dirs : defaultDirs();
  const tally = tallyVariants(dirs.flatMap(loadSessions), args.command);
  process.stdout.write(
    args.json ? `${JSON.stringify(tally, null, 2)}\n` : formatReport(tally),
  );
}
