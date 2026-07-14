/**
 * agent/src/pr-state-reconciler.ts
 *
 * PR state reconciler — self-heals task-store PullRequest records left
 * state:"open" after an untracked merge/close (a session crashed or hung
 * AFTER the real work happened on GitHub but BEFORE the completion PATCH
 * ran). Mirrors task-store's own StaleClaimReaper pattern (batch-scan +
 * per-item resolve + defensive continue-on-error) — see
 * task-store/src/stale-claim-reaper.ts — but lives in agent/src since it
 * needs GitHub read access, which agent/src/check-helpers.ts already
 * provides (ghJson, resolveAllRepos, splitOrgRepo, createTaskStoreClient).
 *
 * Unlike the claim reaper (crash backstop for the *claim* fields only), this
 * reconciles the *business state* (state/mergedAt) against GitHub reality,
 * closing the gap CHU-1.x left: check-deploy.ts/check-review.ts/check-patch.ts
 * only ever scan GitHub's *open* PR list, so a merged/closed PR silently
 * drops out of view before its task-store record gets corrected.
 *
 * This is a pure background interval (agent/src/index.ts), not a Claude
 * session and not folded into the loop-orchestrator's per-tick candidate
 * collection — purely mechanical field sync, no judgment required, and
 * running it every tick would multiply gh API calls unnecessarily.
 *
 * Usage: register via setInterval(() => void reconciler.reconcile(), <ms>)
 * with a 30-60 minute interval — see agent/src/index.ts.
 */

import { resolveAllRepos, resolveWorkspacePath } from "./check-helpers.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal shape of a task-store PullRequest record this reconciler needs. */
export interface PrStateRecord {
  id: string;
  repo: string;
  prNumber: number;
  state: string;
}

/** Result of `gh pr view <n> --json state,mergedAt`. */
export interface GhPrView {
  state: "OPEN" | "MERGED" | "CLOSED";
  mergedAt: string | null;
}

export interface PrStateReconcilerDeps {
  repos: string[];
  /** Page size for listing state:"open" records; defaults to the task-store's own default (50). */
  pageLimit?: number;
  /** List one page of state:"open" PR records for a repo. */
  listOpenPrRecords: (
    repo: string,
    limit: number,
    offset: number,
  ) => Promise<PrStateRecord[]>;
  /** PATCH a task-store PR record's fields. */
  patchPrRecord: (id: string, fields: Record<string, unknown>) => Promise<void>;
  /** Fetch live GitHub state for a single PR. Throws on lookup failure. */
  ghViewPr: (repo: string, prNumber: number) => Promise<GhPrView>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_LIMIT = 50;

/** Map GitHub's uppercase PR state to the task-store's lowercase PrState enum. */
function mapGhStateToPrState(state: GhPrView["state"]): "merged" | "closed" | null {
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return null; // still OPEN on GitHub — nothing to reconcile
}

/**
 * List every state:"open" PR record for a repo, paging through the
 * task-store's default 50-record page until a page returns fewer than
 * `limit` records.
 */
async function listAllOpenRecords(
  deps: PrStateReconcilerDeps,
  repo: string,
): Promise<PrStateRecord[]> {
  const limit = deps.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const records: PrStateRecord[] = [];
  let offset = 0;

  for (;;) {
    const page = await deps.listOpenPrRecords(repo, limit, offset);
    records.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }

  return records;
}

/**
 * Reconcile a single PR record against live GitHub state. Issues a PATCH
 * only when GitHub reports MERGED or CLOSED while the record still says
 * "open" — records still OPEN on GitHub are left completely untouched.
 */
async function reconcileRecord(
  deps: PrStateReconcilerDeps,
  record: PrStateRecord,
): Promise<void> {
  const ghState = await deps.ghViewPr(record.repo, record.prNumber);
  const newState = mapGhStateToPrState(ghState.state);
  if (newState === null) return; // still open on GitHub — no-op

  // claimedBy/claimedAt/heartbeatAt aren't in routes/prs.ts's PATCH
  // allowlist, so including them here is documentation-of-intent rather than
  // a functional requirement — the actual clearing happens server-side in
  // PullRequestService.update()'s state === "merged" || "closed" special
  // case (mirrors CHU-1.3's pattern). `phase` IS allowlisted and is included
  // here for defense-in-depth alongside the server-side clear.
  const fields: Record<string, unknown> = {
    state: newState,
    claimedBy: null,
    claimedAt: null,
    heartbeatAt: null,
    phase: null,
  };
  if (newState === "merged" && ghState.mergedAt) {
    fields.mergedAt = ghState.mergedAt;
  }

  await deps.patchPrRecord(record.id, fields);
}

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Scan every repo's state:"open" PR records, compare each against live
 * GitHub state, and PATCH only the ones that disagree (GitHub shows
 * MERGED/CLOSED but the record still says "open"). A single per-PR gh
 * lookup failure is logged and does not abort reconciliation of the rest
 * of the batch.
 */
export async function reconcilePrState(deps: PrStateReconcilerDeps): Promise<void> {
  for (const repo of deps.repos) {
    let records: PrStateRecord[];
    try {
      records = await listAllOpenRecords(deps, repo);
    } catch (err) {
      console.error(
        `[pr-state-reconciler] failed to list open PRs for ${repo}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }

    for (const record of records) {
      try {
        await reconcileRecord(deps, record);
      } catch (err) {
        console.error(
          `[pr-state-reconciler] failed to reconcile ${repo}#${record.prNumber}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }
}

// ─── Production deps ──────────────────────────────────────────────────────────

interface GhPrViewJson {
  state: "OPEN" | "MERGED" | "CLOSED";
  mergedAt: string | null;
}

interface PrListResponseJson {
  prs: PrStateRecord[];
  total: number;
  limit: number;
  offset: number;
}

export function buildProductionDeps(opts: {
  ghJson: <T>(args: string[]) => T;
  fetchFn?: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): PrStateReconcilerDeps {
  const workspacePath = resolveWorkspacePath();
  const repos = resolveAllRepos(workspacePath);
  const { ghJson } = opts;

  const taskStoreUrl = (process.env.SHIPWRIGHT_TASK_STORE_URL ?? "").trim();
  const taskStoreToken = (process.env.SHIPWRIGHT_TASK_STORE_TOKEN ?? "").trim();
  const baseUrl = taskStoreUrl.replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${taskStoreToken}`,
    "Content-Type": "application/json",
  };
  const doFetch = opts.fetchFn ?? fetch;

  return {
    repos,
    listOpenPrRecords: async (repo: string, limit: number, offset: number) => {
      const params = new URLSearchParams({
        repo,
        state: "open",
        limit: String(limit),
        offset: String(offset),
      });
      const res = await doFetch(`${baseUrl}/prs?${params}`, { headers });
      if (!res.ok) {
        throw new Error(`task-store GET /prs?${params} → ${res.status}`);
      }
      const data = (await res.json()) as PrListResponseJson;
      return data.prs;
    },
    patchPrRecord: async (id: string, fields: Record<string, unknown>) => {
      const res = await doFetch(`${baseUrl}/prs/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(fields),
      });
      if (!res.ok) {
        throw new Error(`task-store PATCH /prs/${id} → ${res.status}`);
      }
    },
    ghViewPr: async (repo: string, prNumber: number) => {
      return ghJson<GhPrViewJson>([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        "state,mergedAt",
      ]);
    },
  };
}
