#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-error-patrol.ts
 *
 * Pre-check for the error-patrol-maintenance cron.
 *
 * Reads state/error-patrol-ledger.json for the previously-seen issue set,
 * fetches currently-unresolved Sentry issues, and diffs them against the
 * ledger using the same new/regressed classification error-scan's SKILL.md
 * documents (Step 5):
 *   - New: no ledger entry exists for the issue id.
 *   - Regressed: an entry exists and either (a) its recorded status was
 *     resolved/ignored (now unresolved again), or (b) its recorded count
 *     is lower than the current count (kept firing since last run).
 *
 * - If the Sentry fetch fails/creds are missing → exit 0 (permissive; can't
 *   rule out work exists).
 * - If zero unresolved issues are new/regressed (including zero unresolved
 *   issues at all) → exit 1 (nothing to do).
 * - Otherwise → exit 0 with a short summary as stdout.
 *
 * Never logs or persists SENTRY_AUTH_TOKEN.
 *
 * Usage:
 *   bun plugins/shipwright/scripts/check-error-patrol.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LedgerIssue {
  status: string;
  count: number;
  lastSeen: string;
}

interface Ledger {
  lastRun: string | null;
  issues: Record<string, LedgerIssue>;
}

interface SentryIssue {
  id: string;
  count: number;
  status: string;
}

interface Deps {
  readLedger: () => Ledger | null;
  fetchUnresolvedIssues: () => Promise<SentryIssue[] | null>;
}

interface RunResult {
  exit: 0 | 1;
  output: string;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * True if a currently-unresolved Sentry issue is new or regressed relative
 * to the ledger's last-recorded state for that issue id. Mirrors error-scan
 * SKILL.md's Step 5 classification.
 */
function isNewOrRegressed(
  issue: SentryIssue,
  ledgerIssues: Record<string, LedgerIssue>,
): boolean {
  const ledgerEntry = ledgerIssues[issue.id];
  if (!ledgerEntry) return true; // New
  if (ledgerEntry.status === "resolved" || ledgerEntry.status === "ignored")
    return true; // Regressed — status flip
  if (issue.count > ledgerEntry.count) return true; // Regressed — count growth
  return false; // Unchanged
}

export async function run(deps: Deps): Promise<RunResult> {
  const ledger = deps.readLedger();
  const ledgerIssues = ledger?.issues ?? {};

  const unresolvedIssues = await deps.fetchUnresolvedIssues();

  // Fetch failure (network error, missing creds, non-2xx) — unknown state,
  // exit permissively per the precheck contract's "err permissive" rule.
  if (unresolvedIssues === null) {
    return {
      exit: 0,
      output:
        "Sentry fetch failed or credentials missing — running permissively.",
    };
  }

  const newOrRegressedCount = unresolvedIssues.filter((issue) =>
    isNewOrRegressed(issue, ledgerIssues),
  ).length;

  if (newOrRegressedCount === 0) {
    return { exit: 1, output: "" };
  }

  return {
    exit: 0,
    output: `${newOrRegressedCount} new/regressed Sentry issue(s) since last run — running error-patrol check.`,
  };
}

// ─── Production deps ──────────────────────────────────────────────────────────

function buildProductionDeps(): Deps {
  const cwd = process.cwd();

  return {
    readLedger: (): Ledger | null => {
      const ledgerPath = join(cwd, "state", "error-patrol-ledger.json");
      if (!existsSync(ledgerPath)) return null;
      try {
        return JSON.parse(readFileSync(ledgerPath, "utf-8")) as Ledger;
      } catch {
        return null;
      }
    },

    fetchUnresolvedIssues: async (): Promise<SentryIssue[] | null> => {
      const sentryOrg = (process.env.SENTRY_ORG ?? "").trim();
      const sentryAuthToken = (process.env.SENTRY_AUTH_TOKEN ?? "").trim();
      if (!sentryOrg || !sentryAuthToken) return null;

      try {
        const res = await fetch(
          `https://sentry.io/api/0/organizations/${sentryOrg}/issues/?query=is:unresolved`,
          { headers: { Authorization: `Bearer ${sentryAuthToken}` } },
        );
        if (!res.ok) return null;
        const data = (await res.json()) as unknown;
        if (!Array.isArray(data)) return null;
        return data.map((item) => {
          const record = item as Record<string, unknown>;
          return {
            id: String(record.id ?? ""),
            count: Number(record.count ?? 0),
            status: String(record.status ?? ""),
          };
        });
      } catch {
        return null;
      }
    },
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
