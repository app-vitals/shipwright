#!/usr/bin/env bun
/**
 * scripts/check-competitive-freshness.ts
 *
 * Precheck for a competitive-freshness cron (not yet wired up — that wiring,
 * plus the paired refresh runbook it points at, is a separate task: CF-2.1).
 *
 * Mirrors plugins/shipwright/scripts/check-site-docs-freshness.ts's structure
 * and exit 0/1 contract, but compares DATES instead of git SHAs: every page
 * under site/src/pages/vs/*.astro carries a top-level
 * `const verifiedDate = "<Month D, YYYY>";`, and site/src/pages/compare.astro
 * carries the same field per entry in its `landscape` array (MESSAGING.md
 * D10's "facts verified as of {date}" marker, tracked per competitor claim).
 *
 * A page/row qualifies (is stale) when its verifiedDate is more than a
 * configurable threshold old (default 30 days). A missing or unparseable
 * verifiedDate also qualifies — permissive on unknown state, mirroring
 * check-site-docs-freshness.ts's own git-failure handling. One page's
 * evaluation failure is isolated and does not suppress findings for others.
 *
 * Exit 0 + summary → at least one page/row is stale (or unparseable/missing).
 *   The summary IS the entire prompt a dispatching cron hands to Claude next
 *   (see agent/src/cron-handler.ts's preCheck contract), so it names every
 *   qualifying page/row with its days-since-verified and explicitly points at
 *   scripts/competitive-refresh-runbook.md (CF-2.1) to act on it.
 * Exit 1 + no output → nothing to do.
 *
 * Usage:
 *   bun scripts/check-competitive-freshness.ts
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Deps {
  /** Raw file content of each site/src/pages/vs/*.astro page, keyed by a
   *  repo-relative path used for display (e.g. "site/src/pages/vs/devin.astro"). */
  vsPages: Record<string, string>;
  /** Raw file content of site/src/pages/compare.astro, or null if it could
   *  not be read (treated as qualifying — permissive on unknown state). */
  compareSource: string | null;
  /** Injected clock — never call Date.now()/`new Date()` directly in the
   *  testable logic below. */
  now: () => Date;
  /** Staleness threshold in days. Defaults to 30 when omitted. */
  thresholdDays?: number;
}

interface RunResult {
  exit: 0 | 1;
  output: string;
}

type Reason = "stale" | "missing" | "unparseable";

interface Finding {
  label: string;
  daysSince: number | null;
  reason: Reason;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLD_DAYS = 30;
const RUNBOOK_PATH = "scripts/competitive-refresh-runbook.md";

const VERIFIED_DATE_CONST_RE = /const\s+verifiedDate\s*=\s*"([^"]*)"/;
const TOOL_FIELD_RE = /tool:\s*"([^"]*)"/g;
const VERIFIED_DATE_FIELD_RE = /verifiedDate:\s*"([^"]*)"/;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

// ─── Pure date evaluation ───────────────────────────────────────────────────

/**
 * Evaluate a single verifiedDate string against `now` and the threshold.
 * A null/empty date "qualifies" as missing; an unparseable one qualifies as
 * unparseable; a parseable one qualifies as stale only when it is MORE than
 * `thresholdDays` old (exactly at the threshold does not qualify).
 */
function evaluateDate(
  dateStr: string | null | undefined,
  now: Date,
  thresholdDays: number,
): { qualifies: boolean; daysSince: number | null; reason: Reason | null } {
  if (dateStr === null || dateStr === undefined || dateStr.trim() === "") {
    return { qualifies: true, daysSince: null, reason: "missing" };
  }

  const parsed = new Date(dateStr);
  if (Number.isNaN(parsed.getTime())) {
    return { qualifies: true, daysSince: null, reason: "unparseable" };
  }

  const daysSince = Math.floor(
    (now.getTime() - parsed.getTime()) / MS_PER_DAY,
  );
  if (daysSince > thresholdDays) {
    return { qualifies: true, daysSince, reason: "stale" };
  }
  return { qualifies: false, daysSince, reason: null };
}

// ─── Per-source evaluation ──────────────────────────────────────────────────

/** Evaluate one vs/*.astro page's top-level `const verifiedDate = "...";`. */
function evaluateVsPage(
  label: string,
  content: string,
  now: Date,
  thresholdDays: number,
): Finding | null {
  const match = content.match(VERIFIED_DATE_CONST_RE);
  const dateStr = match ? match[1] : null;
  const result = evaluateDate(dateStr, now, thresholdDays);
  if (!result.qualifies) return null;
  return { label, daysSince: result.daysSince, reason: result.reason! };
}

/**
 * Evaluate every entry of compare.astro's `landscape` array. Parsing is
 * regex-based (not a full JS/TS parse, matching this repo's precedent of
 * treating source files as text for lightweight structural checks): each
 * `tool: "X"` occurrence opens a row, and the row's own `verifiedDate: "Y"`
 * field is whatever comes between it and the NEXT `tool: "..."` occurrence
 * (or end of file, for the last row). This is robust to nested objects
 * (e.g. a row's `citations` array) since it never tries to balance braces.
 */
function evaluateCompareRows(
  content: string,
  now: Date,
  thresholdDays: number,
): Finding[] {
  const findings: Finding[] = [];
  const toolMatches = [...content.matchAll(TOOL_FIELD_RE)];

  for (let i = 0; i < toolMatches.length; i++) {
    const toolMatch = toolMatches[i];
    const toolName = toolMatch[1];
    const blockStart = (toolMatch.index ?? 0) + toolMatch[0].length;
    const blockEnd =
      i + 1 < toolMatches.length ? (toolMatches[i + 1].index ?? content.length) : content.length;
    const block = content.slice(blockStart, blockEnd);

    const dateMatch = block.match(VERIFIED_DATE_FIELD_RE);
    const dateStr = dateMatch ? dateMatch[1] : null;
    const result = evaluateDate(dateStr, now, thresholdDays);
    if (result.qualifies) {
      findings.push({
        label: `compare.astro: ${toolName}`,
        daysSince: result.daysSince,
        reason: result.reason!,
      });
    }
  }

  return findings;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

export async function run(deps: Deps): Promise<RunResult> {
  const now = deps.now();
  const thresholdDays = deps.thresholdDays ?? DEFAULT_THRESHOLD_DAYS;
  const findings: Finding[] = [];

  for (const [label, content] of Object.entries(deps.vsPages)) {
    try {
      const finding = evaluateVsPage(label, content, now, thresholdDays);
      if (finding) findings.push(finding);
    } catch (err) {
      process.stderr.write(
        `check-competitive-freshness: evaluation failed for ${label}: ${String(err)}\n`,
      );
      // Permissive on unexpected failure — one page's error must not
      // suppress a real finding for another page, so still flag it.
      findings.push({ label, daysSince: null, reason: "unparseable" });
    }
  }

  if (deps.compareSource === null) {
    // Unreadable/missing compare.astro is unknown state — flag it rather
    // than silently skipping the whole file's worth of rows.
    findings.push({ label: "compare.astro", daysSince: null, reason: "missing" });
  } else {
    try {
      findings.push(...evaluateCompareRows(deps.compareSource, now, thresholdDays));
    } catch (err) {
      process.stderr.write(
        `check-competitive-freshness: evaluation failed for compare.astro: ${String(err)}\n`,
      );
      findings.push({ label: "compare.astro", daysSince: null, reason: "unparseable" });
    }
  }

  if (findings.length === 0) return { exit: 1, output: "" };

  const lines = findings.map((f) => {
    const detail =
      f.reason === "missing"
        ? "missing verifiedDate"
        : f.reason === "unparseable"
          ? "unparseable verifiedDate"
          : `${f.daysSince} days since last verified`;
    return `- ${f.label}: ${detail}`;
  });

  const output = [
    "Competitive positioning freshness check found stale or unverifiable pages/rows:",
    "",
    ...lines,
    "",
    `Follow ${RUNBOOK_PATH} to re-verify each item listed above and refresh its verifiedDate.`,
  ].join("\n");

  return { exit: 0, output };
}

// ─── Production deps ──────────────────────────────────────────────────────────

function buildProductionDeps(): Deps {
  // This script lives in this repo's own repo-root scripts/ (not the
  // distributable plugins/shipwright/scripts/) — resolve the repo root
  // relative to the script's own location so it works the same whether
  // invoked from a `repos/` clone or a `worktrees/` checkout.
  const scriptDir = import.meta.dirname ?? process.cwd();
  const repoDir = join(scriptDir, "..");
  const vsDir = join(repoDir, "site", "src", "pages", "vs");
  const compareFilePath = join(repoDir, "site", "src", "pages", "compare.astro");

  const vsPages: Record<string, string> = {};
  if (existsSync(vsDir)) {
    for (const entry of readdirSync(vsDir)) {
      if (!entry.endsWith(".astro")) continue;
      const label = `site/src/pages/vs/${entry}`;
      try {
        vsPages[label] = readFileSync(join(vsDir, entry), "utf-8");
      } catch (err) {
        process.stderr.write(
          `check-competitive-freshness: failed to read ${label}: ${String(err)} — treating as qualifying\n`,
        );
        // Empty content has no verifiedDate match — evaluates as "missing",
        // which is the correct permissive outcome for an unreadable page.
        vsPages[label] = "";
      }
    }
  }

  let compareSource: string | null = null;
  try {
    compareSource = existsSync(compareFilePath)
      ? readFileSync(compareFilePath, "utf-8")
      : null;
  } catch (err) {
    process.stderr.write(
      `check-competitive-freshness: failed to read compare.astro: ${String(err)} — treating as qualifying\n`,
    );
    compareSource = null;
  }

  return {
    vsPages,
    compareSource,
    now: () => new Date(),
    thresholdDays: DEFAULT_THRESHOLD_DAYS,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const deps = buildProductionDeps();
  const result = await run(deps);
  if (result.exit === 0) {
    process.stdout.write(`${result.output}\n`);
  }
  process.exit(result.exit);
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    process.stderr.write(`error: ${String(e)}\n`);
    process.exit(2);
  });
}
