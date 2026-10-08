#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/prompt-audit/cli.ts
 *
 * Prompt-audit CLI.
 *
 *   scan    [--repo <dir>] [--model <id>]... [--scope <path>] [--json]
 *           [--dry-run] [--since-days 28]
 *   measure --finding <fp> --before <ref> --after <ref> --model <id>
 *           [--repo <dir>] [--json] [--record]
 *   blast   --file <path> [--repo <dir>] [--json]
 *
 * `scan` writes state/prompt-audit-ledger.json and prompt-audit-report.md
 * (neither on --dry-run; the token cache is the only other write). All
 * filesystem, git, clock and token-counting access is injected via `CliDeps`.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { analyzeBlameAge, type BlameAge } from "./blame-age.ts";
import { type BlastReport, blastRadius } from "./blast.ts";
import { CONTEXTS, type RuleContext } from "./finding.ts";
import { type InventoryDeps, walkInventory } from "./inventory.ts";
import {
  type Baseline,
  LEDGER_PATH,
  type LedgerFs,
  mergeScan,
  readLedger,
  recordMeasurement,
  type ScanFinding,
  writeLedger,
} from "./ledger.ts";
import {
  findOrphanedAutoSections,
  resolveReferences,
} from "./reference-resolver.ts";
import { REPORT_PATH, renderReport } from "./report.ts";
import { runAllRules } from "./rules.ts";
import {
  type CountTokensDeps,
  DEFAULT_CACHE_PATH,
  countTokens as realCountTokens,
  type TokenCount,
} from "./token-count.ts";
import {
  fetchCronSkillStats,
  readLocalSkillStats,
  type SkillStat,
} from "./usage-attribution.ts";

export const DEFAULT_MODELS = ["claude-sonnet-5-5", "claude-sonnet-4-6"];
const DEFAULT_SINCE_DAYS = 28;
const WEEK_DAYS = 7;

export interface CliFs extends InventoryDeps {
  exists(root: string, relPath: string): boolean;
  writeFile(root: string, relPath: string, content: string): void;
}

export interface CliDeps {
  fs: CliFs;
  /** Run a command with `cwd` as working directory; returns stdout, throws on failure. */
  exec(cwd: string, cmd: string[]): string;
  now(): Date;
  countTokens(
    texts: string[],
    models: string[],
    deps?: CountTokensDeps,
  ): Promise<Record<string, TokenCount[]>>;
  loadUsage(opts: { sinceDays: number }): Promise<SkillStat[] | null>;
  env: Record<string, string | undefined>;
}

export interface CliResult {
  exit: number;
  stdout: string;
}

export interface ParsedArgs {
  command: string;
  flags: Set<string>;
  values: Record<string, string>;
  multi: Record<string, string[]>;
}

const BOOLEAN_FLAGS = new Set(["json", "dry-run", "record"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const out: ParsedArgs = { command, flags: new Set(), values: {}, multi: {} };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) continue;
    const name = a.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      out.flags.add(name);
      continue;
    }
    const value = rest[++i];
    if (value === undefined) continue;
    out.values[name] = value;
    out.multi[name] = [...(out.multi[name] ?? []), value];
  }
  return out;
}

// ─── scan ────────────────────────────────────────────────────────────────────

function rateKeys(root: string, deps: CliDeps): string[] {
  if (!deps.fs.exists(root, "lib/pricing.ts")) return [];
  const text = deps.fs.readFile(root, "lib/pricing.ts");
  const block = /RATES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(text)?.[1] ?? "";
  return [...block.matchAll(/^\s*"?([\w.-]+)"?\s*:\s*\{/gm)].map((m) => m[1]);
}

function resolveModels(args: ParsedArgs, deps: CliDeps): string[] {
  const given = args.multi.model;
  if (given?.length) return [...new Set(given)];
  return [
    ...new Set(
      [deps.env.ANTHROPIC_MODEL, ...DEFAULT_MODELS].filter(
        (m): m is string => !!m,
      ),
    ),
  ];
}

async function runScan(args: ParsedArgs, deps: CliDeps): Promise<CliResult> {
  const root = resolve(args.values.repo ?? ".");
  const models = resolveModels(args, deps);
  const dryRun = args.flags.has("dry-run");
  const sinceDays = Number(args.values["since-days"] ?? DEFAULT_SINCE_DAYS);
  const scope = args.values.scope;
  const now = deps.now();

  const items = walkInventory(root, deps.fs);
  const read = (p: string) => deps.fs.readFile(root, p);
  const texts = items.map((i) => read(i.path));
  const counted = await deps.countTokens(texts, models, {
    cachePath: join(root, DEFAULT_CACHE_PATH),
  });
  const tokens: RuleContext["tokens"] = {};
  items.forEach((item, idx) => {
    tokens[item.path] = Object.fromEntries(
      models.map((m) => [m, counted[m][idx]]),
    );
  });

  const blame: Record<string, BlameAge> = {};
  for (const item of items) {
    try {
      blame[item.path] = analyzeBlameAge(item.path, {
        exec: (cmd) => deps.exec(root, cmd),
        now: Math.floor(now.getTime() / 1000),
      });
    } catch {
      // not a git checkout or untracked file: no blame data
    }
  }

  const usage = await deps.loadUsage({ sinceDays });
  const totalRuns = Math.max(0, ...(usage ?? []).map((s) => s.runs));
  const ctx: RuleContext = {
    items,
    read,
    models,
    tokens,
    unresolved: resolveReferences(root, {
      ...deps.fs,
      rateKeys: rateKeys(root, deps),
    }),
    orphans: findOrphanedAutoSections(root, deps.fs),
    blame,
    usage,
    totalRuns,
    usageWindowDays: sinceDays,
  };

  let sha = "unknown";
  try {
    sha = deps.exec(root, ["git", "rev-parse", "HEAD"]).trim() || sha;
  } catch {
    // not a git checkout
  }

  const blastCache = new Map<string, BlastReport>();
  const findings: ScanFinding[] = runAllRules(ctx)
    .filter((f) => !scope || f.file.startsWith(scope))
    .map((f) => {
      let b = blastCache.get(f.file);
      if (!b) {
        b = blastRadius(f.file, root, deps.fs);
        blastCache.set(f.file, b);
      }
      return { ...f, blastRadius: b, scannedAt: sha };
    });

  const baselines: Record<string, Record<string, Baseline>> = {};
  for (const context of CONTEXTS) {
    baselines[context] = {};
    const always = items.filter((i) => i.loadClass[context] === "always");
    const listingChars = items
      .filter((i) => i.loadClass[context] === "listing")
      .reduce((s, i) => s + i.descriptionChars, 0);
    for (const model of models) {
      const counts = always.map((i) => tokens[i.path][model]);
      baselines[context][model] = {
        alwaysTokens: counts.reduce((s, c) => s + c.tokens, 0),
        listingChars,
        estimated: counts.some((c) => c.estimated),
      };
    }
  }

  const ledgerFs: LedgerFs = {
    exists: (p) => deps.fs.exists(root, p),
    read: (p) => deps.fs.readFile(root, p),
    write: (p, c) => deps.fs.writeFile(root, p, c),
  };
  const ledger = mergeScan(
    readLedger(ledgerFs, LEDGER_PATH),
    {
      findings,
      models,
      baselines,
      claudeCodeVersion: deps.env.CLAUDE_CODE_VERSION,
    },
    now,
  );
  const weeklyRuns = totalRuns > 0 ? (totalRuns * WEEK_DAYS) / sinceDays : 1;
  const report = renderReport({ ledger, generatedAt: now, weeklyRuns });

  if (!dryRun) {
    writeLedger(ledgerFs, LEDGER_PATH, ledger);
    deps.fs.writeFile(root, REPORT_PATH, report);
  }

  if (args.flags.has("json")) {
    return {
      exit: 0,
      stdout: `${JSON.stringify({ scannedAt: sha, models, dryRun, baselines, findings }, null, 2)}\n`,
    };
  }
  return {
    exit: 0,
    stdout: `${findings.length} findings across ${models.join(", ")} at ${sha.slice(0, 7)}${dryRun ? " (dry run: nothing written)" : `; wrote ${LEDGER_PATH} and ${REPORT_PATH}`}\n`,
  };
}

// ─── measure ─────────────────────────────────────────────────────────────────

async function runMeasure(args: ParsedArgs, deps: CliDeps): Promise<CliResult> {
  const { finding, before, after, model } = args.values;
  if (!finding || !before || !after || !model) {
    return {
      exit: 2,
      stdout:
        "usage: measure --finding <fp> --before <ref> --after <ref> --model <id> [--repo <dir>] [--json] [--record]\n",
    };
  }
  const root = resolve(args.values.repo ?? ".");
  const ledgerFs: LedgerFs = {
    exists: (p) => deps.fs.exists(root, p),
    read: (p) => deps.fs.readFile(root, p),
    write: (p, c) => deps.fs.writeFile(root, p, c),
  };
  const ledger = readLedger(ledgerFs, LEDGER_PATH);
  const entry = ledger.findings[finding];
  if (!entry)
    return { exit: 1, stdout: `finding ${finding} is not in ${LEDGER_PATH}\n` };

  const show = (ref: string): string => {
    try {
      return deps.exec(root, ["git", "show", `${ref}:${entry.file}`]);
    } catch {
      return ""; // file absent at that ref: zero tokens
    }
  };
  const counted = await deps.countTokens([show(before), show(after)], [model], {
    cachePath: join(root, DEFAULT_CACHE_PATH),
  });
  const [b, a] = counted[model];
  const result = {
    fingerprint: finding,
    file: entry.file,
    model,
    before: { ref: before, tokens: b.tokens },
    after: { ref: after, tokens: a.tokens },
    tokenDelta: a.tokens - b.tokens,
    estimated: b.estimated || a.estimated,
  };
  if (args.flags.has("record")) {
    const now = deps.now();
    writeLedger(
      ledgerFs,
      LEDGER_PATH,
      recordMeasurement(
        ledger,
        finding,
        {
          kind: "static",
          before: b.tokens,
          after: a.tokens,
          delta: result.tokenDelta,
          costUsd: 0,
          runAt: now.toISOString(),
        },
        now,
      ),
    );
  }
  if (args.flags.has("json"))
    return { exit: 0, stdout: `${JSON.stringify(result, null, 2)}\n` };
  return {
    exit: 0,
    stdout: `${entry.file} on ${model}: ${b.tokens} -> ${a.tokens} tokens (tokenDelta ${result.tokenDelta})${result.estimated ? " [estimate]" : ""}\n`,
  };
}

// ─── blast ───────────────────────────────────────────────────────────────────

export function formatBlast(r: BlastReport): string {
  const list = <T>(rows: T[], f: (x: T) => string) =>
    rows.length ? rows.map((x) => `  - ${f(x)}`) : ["  (none)"];
  return `${[
    `Blast radius: ${r.file}`,
    `Load class: ${r.loadClass ? CONTEXTS.map((c) => `${c}=${r.loadClass?.[c]}`).join(", ") : "not an inventoried prompt file"}`,
    "Referrers:",
    ...list(
      r.referrers,
      (x) =>
        `${x.path} (${x.kind}, ${x.via}${x.line ? `, line ${x.line}` : ""})`,
    ),
    "Cron prompts:",
    ...list(
      r.crons,
      (x) => `${x.name}${x.loopPhase ? ` (loop phase ${x.loopPhase})` : ""}`,
    ),
    "Pinning tests:",
    ...list(
      r.pinningTests,
      (x) => `${x.file} (${x.assertions.length} assertions)`,
    ),
    "Source-map pages:",
    ...list(r.sourceMapPages, (x) => x),
    r.note,
  ].join("\n")}\n`;
}

function runBlast(args: ParsedArgs, deps: CliDeps): CliResult {
  const file = args.values.file;
  if (!file)
    return {
      exit: 2,
      stdout: "usage: blast --file <path> [--repo <dir>] [--json]\n",
    };
  const report = blastRadius(file, resolve(args.values.repo ?? "."), deps.fs);
  return {
    exit: 0,
    stdout: args.flags.has("json")
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatBlast(report),
  };
}

// ─── entry ───────────────────────────────────────────────────────────────────

export async function runCli(
  argv: string[],
  deps: CliDeps,
): Promise<CliResult> {
  const args = parseArgs(argv);
  try {
    switch (args.command) {
      case "scan":
        return await runScan(args, deps);
      case "measure":
        return await runMeasure(args, deps);
      case "blast":
        return runBlast(args, deps);
      default:
        return {
          exit: 2,
          stdout: "usage: cli.ts <scan|measure|blast> [options]\n",
        };
    }
  } catch (err) {
    return {
      exit: 1,
      stdout: `error: ${err instanceof Error ? err.message : String(err)}\n`,
    };
  }
}

const SKIP_DIRS = new Set(["node_modules", ".git"]);

function walk(root: string, base = ""): string[] {
  return readdirSync(join(root, base), { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory())
      return SKIP_DIRS.has(e.name) ? [] : walk(root, `${base}${e.name}/`);
    return [`${base}${e.name}`];
  });
}

export function nodeCliDeps(): CliDeps {
  return {
    fs: {
      listFiles: (root) => walk(root),
      readFile: (root, rel) => readFileSync(join(root, rel), "utf8"),
      exists: (root, rel) => existsSync(join(root, rel)),
      writeFile: (root, rel, content) => {
        const abs = join(root, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      },
    },
    exec: (cwd, cmd) => {
      const r = spawnSync(cmd[0], cmd.slice(1), {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      if (r.status !== 0)
        throw new Error(r.stderr || `${cmd.join(" ")} failed`);
      return r.stdout;
    },
    now: () => new Date(),
    countTokens: realCountTokens,
    loadUsage: async ({ sinceDays }) => {
      const from = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
      return (await fetchCronSkillStats({ from })) ?? readLocalSkillStats();
    },
    env: process.env,
  };
}

if (import.meta.main) {
  const res = await runCli(process.argv.slice(2), nodeCliDeps());
  process.stdout.write(res.stdout);
  process.exit(res.exit);
}
