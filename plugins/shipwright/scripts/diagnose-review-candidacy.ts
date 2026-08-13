#!/usr/bin/env bun
// On-demand review-candidacy diagnostic script (RCO-1.4).
//
// Fetches fresh LIVE state (GitHub PR metadata, live reviews, task-store PR
// record) for exactly one PR — the same state getReviewCandidates() would
// fetch for that PR — and runs it through RCO-1.3's exported
// traceReviewCandidacyDecision() to print exactly which check excludes the
// PR (or confirms it's eligible) right now, with the field values that drove
// the decision. Exists to replace the multi-hour historical-log
// reconstruction a stuck-PR incident (ok-wow/ok-wow-agency#66) required with
// a single command anyone (including an agent debugging its own PR) can run.
//
// Deliberately imports traceReviewCandidacyDecision directly from
// agent/src/check-review.ts rather than re-deriving the exclusion logic —
// see that file's doc comment ("Deliberately exported ... so RCO-1.4's
// diagnostic script can call the same classification logic directly instead
// of re-deriving it"). This is a narrow, intentional exception to the usual
// "plugins/shipwright is a separate, repo-agnostic package from agent/src,
// duplicate rather than import" convention followed by this directory's
// other scripts (compute-review-verdict.ts, compute-unaddressed-findings.ts)
// — AC2 of this task explicitly requires calling the same function, not a
// copy. plugins/shipwright/tsconfig.json's `include` array is extended with
// `../../agent/src` to make this cross-package relative import satisfy TS's
// rootDir constraint (mirrors agent/tsconfig.json's existing
// `../admin/src` precedent for @shipwright/admin).
//
// Note: this only covers the "later" exclusion checks that
// traceReviewCandidacyDecision itself covers (live-review dedup,
// task-blocked, bundle-incomplete, claimed, pr-record-blocked,
// already-reviewed-terminal, staged) — NOT the early, cheap in-memory checks
// getReviewCandidates applies inline before ever reaching those (draft,
// dependabot, automated-label, self-review, not-allowlisted). Out of scope
// per RCO-1.3's own doc comment and this task's AC2 ("RCO-1.3's exported
// trace function").
//
// CLI:
//   bun run plugins/shipwright/scripts/diagnose-review-candidacy.ts org/repo#123
//   bun run plugins/shipwright/scripts/diagnose-review-candidacy.ts ok-wow/ok-wow-agency#66

import { ghGraphql, ghJson } from "../../../agent/src/check-helpers.ts";
import type { LinkedTaskInfo } from "../../../agent/src/check-helpers.ts";
import type { PrReviewData } from "../../../agent/src/check-patch.ts";
import {
  type PrInfo,
  type PrRecord,
  type ReviewCandidacyTrace,
  buildProductionDeps,
  traceReviewCandidacyDecision,
} from "../../../agent/src/check-review.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DiagnoseTarget = { org: string; repo: string; prNumber: number };

export interface DiagnoseDeps {
  fetchPrInfo: (org: string, repo: string, prNumber: number) => Promise<PrInfo>;
  queryPrRecord: (repo: string, prNumber: number) => Promise<PrRecord | null>;
  queryTaskStatus: (
    repo: string,
    prNumber: number,
  ) => Promise<LinkedTaskInfo | null>;
  isBundleComplete: (branch: string) => Promise<boolean>;
  fetchPrReviews: (
    org: string,
    repo: string,
    pr: number,
  ) => Promise<PrReviewData>;
}

// ─── parseTargetArg ─────────────────────────────────────────────────────────

/** Parse "org/repo#123" into { org, repo, prNumber }. Throws a clear error on malformed input. */
export function parseTargetArg(raw: string): DiagnoseTarget {
  const match = /^([^/#]+)\/([^/#]+)#(\d+)$/.exec(raw.trim());
  if (!match) {
    throw new Error(
      `Invalid target "${raw}" — expected the form "org/repo#123" (e.g. "ok-wow/ok-wow-agency#66").`,
    );
  }
  const [, org, repo, prNumberRaw] = match;
  return { org, repo, prNumber: Number.parseInt(prNumberRaw, 10) };
}

// ─── diagnoseReviewCandidacy ────────────────────────────────────────────────

/**
 * Fetch fresh live state for exactly one PR — mirroring what
 * getReviewCandidates() fetches for a PR once it reaches the "later"
 * exclusion checks — and run it through traceReviewCandidacyDecision().
 */
export async function diagnoseReviewCandidacy(
  target: DiagnoseTarget,
  deps: DiagnoseDeps,
): Promise<{ pr: PrInfo; trace: ReviewCandidacyTrace }> {
  const { org, repo, prNumber } = target;
  const fullRepo = `${org}/${repo}`;

  const pr = await deps.fetchPrInfo(org, repo, prNumber);

  let record: PrRecord | null = null;
  try {
    record = await deps.queryPrRecord(fullRepo, prNumber);
  } catch {
    // Query failed → treat as eligible (no dedup), matching getReviewCandidates.
  }

  // hasFreshAuthorReply (RFR-1.1) — replicated inline exactly as
  // getReviewCandidates() computes it: a comment authored by the PR's own
  // author, with createdAt after the record's reviewedAt watermark (epoch 0
  // when there's no record yet, so any author comment counts).
  const reviewedAtMs = new Date(record?.reviewedAt ?? 0).getTime();
  let reviewData: PrReviewData | undefined;
  let hasFreshAuthorReply = false;
  try {
    reviewData = await deps.fetchPrReviews(org, repo, prNumber);
    hasFreshAuthorReply =
      reviewData?.comments.nodes.some(
        (c) =>
          c.author.login === pr.author.login &&
          new Date(c.createdAt).getTime() > reviewedAtMs,
      ) ?? false;
  } catch {
    // Fetch failed → treat as "no terminal review" (no dedup).
  }

  let linkedTask: LinkedTaskInfo | null = null;
  try {
    linkedTask = await deps.queryTaskStatus(fullRepo, prNumber);
  } catch {
    linkedTask = null;
  }

  let isBundleComplete: boolean | undefined;
  try {
    isBundleComplete = await deps.isBundleComplete(pr.headRefName);
  } catch {
    isBundleComplete = true;
  }

  const trace = traceReviewCandidacyDecision({
    pr,
    record,
    reviewData,
    hasFreshAuthorReply,
    linkedTask,
    isBundleComplete,
  });

  return { pr, trace };
}

// ─── formatTraceOutput ──────────────────────────────────────────────────────

/** Human-readable summary of a trace result: eligible, or the excluding check plus its field values. */
export function formatTraceOutput(
  pr: PrInfo,
  trace: ReviewCandidacyTrace,
): string {
  const target = `${pr.repo ?? "unknown"}#${pr.number}`;
  const lines: string[] = [`PR: ${target} — "${pr.title}"`];

  if (trace.check === "eligible") {
    lines.push("Status: ELIGIBLE — no exclusion check excluded this PR.");
    return lines.join("\n");
  }

  lines.push(`Status: EXCLUDED (check: "${trace.check}")`);
  const { check, ...fields } = trace;
  if (Object.keys(fields).length > 0) {
    for (const [key, value] of Object.entries(fields)) {
      lines.push(`  ${key}: ${JSON.stringify(value)}`);
    }
  }
  return lines.join("\n");
}

// ─── Production deps ──────────────────────────────────────────────────────────

/**
 * Fetch PR metadata via `gh pr view` and stamp `repo` onto the result — `gh`
 * doesn't return a `repo` field itself, so it's added from the already-known
 * org/repo, mirroring check-review.ts's production `listOpenPrs`
 * (`.map((pr) => ({ ...pr, repo }))`). Takes `ghJsonFn` as a parameter so
 * this can be unit-tested with an injected fake instead of the real `gh` CLI.
 */
export async function fetchPrInfoViaGh(
  ghJsonFn: typeof ghJson,
  org: string,
  repo: string,
  prNumber: number,
): Promise<PrInfo> {
  const pr = await ghJsonFn<PrInfo>([
    "pr",
    "view",
    "--repo",
    `${org}/${repo}`,
    String(prNumber),
    "--json",
    "number,title,author,headRefName,headRefOid,isDraft,labels,createdAt,reviewRequests",
  ]);
  return { ...pr, repo: `${org}/${repo}` };
}

/** Wire production implementations — real gh CLI + task-store calls. */
export async function buildDiagnoseDeps(): Promise<DiagnoseDeps> {
  const productionDeps = await buildProductionDeps({ ghJson, ghGraphql });
  return {
    fetchPrInfo: (org: string, repo: string, prNumber: number) =>
      fetchPrInfoViaGh(ghJson, org, repo, prNumber),
    queryPrRecord: productionDeps.queryPrRecord,
    queryTaskStatus: async (repo: string, prNumber: number) =>
      (await productionDeps.queryTaskStatus?.(repo, prNumber)) ?? null,
    isBundleComplete: async (branch: string) =>
      (await productionDeps.isBundleComplete?.(branch)) ?? true,
    fetchPrReviews: productionDeps.fetchPrReviews,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const arg = process.argv[2];
  if (!arg) {
    console.error(
      "Usage: bun run plugins/shipwright/scripts/diagnose-review-candidacy.ts org/repo#123",
    );
    process.exit(1);
  }
  const target = parseTargetArg(arg);
  const deps = await buildDiagnoseDeps();
  const { pr, trace } = await diagnoseReviewCandidacy(target, deps);
  console.log(formatTraceOutput(pr, trace));
}
