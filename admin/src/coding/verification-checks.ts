/**
 * admin/src/coding/verification-checks.ts
 * Task-store verification-check reads (LVB-5.x) for the coding admin UI: the
 * newest-window fetch behind the task/PR detail "Verification Checks" cards,
 * and the agent detail page's "Recent Verification Activity" rollup. Moved
 * out of admin-ui.ts (AEP-3.2).
 */

import type {
  VerificationActivitySummary,
  VerificationCheckItem,
} from "./admin-ui-verification-cards.ts";
import type { PrListItem } from "./admin-ui-work-item-pages.ts";

/**
 * Max verification-check rows fetched per task/PR for the detail cards and the
 * agent rollup. The task-store's GET /verification-checks returns rows `at`
 * ascending (oldest first) with a default `limit` of 50 (see
 * task-store/src/verification-check-service.ts's list()), so an unqualified
 * request yields the OLDEST 50 rows — exactly the wrong end of the history for
 * a "most recent run per checkName" view once a task/PR records more than one
 * page of checks.
 */
const VERIFICATION_CHECKS_PAGE_LIMIT = 200;

/** Shape of the optional task-store verification-check fetcher (see AdminUIDeps). */
export type FetchVerificationChecks = (
  params: URLSearchParams,
) => Promise<{ checks: VerificationCheckItem[]; total?: number }>;

/**
 * Fetches the most RECENT window of a task's/PR's verification-check history,
 * so mostRecentVerificationChecksByCheckName()/buildVerificationActivityRollup()
 * reduce over rows that actually contain each checkName's latest run.
 *
 * GET /verification-checks exposes no `order=desc` option — only `limit`/
 * `offset` over an ascending scan — so "the newest page" is expressed as "the
 * LAST page": request `limit` rows, and if the response's `total` says the
 * history is longer than what came back, re-request at
 * `offset = total - limit`. That second round-trip only happens for a task/PR
 * with more than VERIFICATION_CHECKS_PAGE_LIMIT recorded checks; every other
 * call stays a single request. (If rows are appended between the two calls the
 * window shifts by at most that many rows — harmless for a "latest per
 * checkName" reduction over a 200-row window.)
 */
export async function fetchRecentVerificationChecks(
  fetchVerificationChecks: FetchVerificationChecks,
  parent: { taskId: string } | { prId: string },
): Promise<VerificationCheckItem[]> {
  const buildParams = () =>
    new URLSearchParams({
      ...parent,
      limit: String(VERIFICATION_CHECKS_PAGE_LIMIT),
    });

  const first = await fetchVerificationChecks(buildParams());
  const total = typeof first.total === "number" ? first.total : 0;
  if (total <= first.checks.length) return first.checks;

  const tailParams = buildParams();
  tailParams.set("offset", String(total - VERIFICATION_CHECKS_PAGE_LIMIT));
  const tail = await fetchVerificationChecks(tailParams);
  return tail.checks;
}

/**
 * Builds the "Recent Verification Activity" rollup for the agent detail page
 * (LVB-5.3 AC2) from the agent's most recent cron-run dispatch targets.
 * There is no task-store query to list "all tasks/PRs claimed by agent X"
 * directly (GET /tasks only supports ?assignee=, GET /prs has no agent
 * filter), so this reuses the same itemType/itemId dispatch-target data the
 * existing Queue Activity page already renders (see workItemLink() in
 * admin-ui-pages.ts) — up to `maxItems` distinct recent {itemType, itemId}
 * pairs are extracted, a "pr" reference is resolved to its task-store record
 * id via fetchTaskStorePrs (mirroring joinPrsByTaskId's repo+prNumber
 * lookup; a "task" reference needs no resolution, Task.id IS the human
 * string task-store expects), then each item's verification checks are
 * fetched and aggregated in parallel. A failed lookup for one item is
 * swallowed so it never breaks the whole rollup — returns undefined (no
 * card) only when the fetcher is absent; when no items qualify or nothing
 * came back it returns a zero-check summary so the card renders an empty
 * state instead of silently disappearing.
 */
function emptyVerificationActivity(): VerificationActivitySummary {
  return { totalChecks: 0, itemCount: 0, counts: {} };
}

export async function buildVerificationActivityRollup(
  runs: { itemType?: string | null; itemId?: string | null }[],
  fetchVerificationChecks: FetchVerificationChecks | undefined,
  fetchTaskStorePrs:
    | ((params: URLSearchParams) => Promise<{ prs: PrListItem[] }>)
    | undefined,
  maxItems = 10,
): Promise<VerificationActivitySummary | undefined> {
  if (!fetchVerificationChecks) return undefined;

  const seen = new Set<string>();
  const distinctItems: { itemType: "task" | "pr"; itemId: string }[] = [];
  for (const run of runs) {
    if (!run.itemType || !run.itemId) continue;
    if (run.itemType !== "task" && run.itemType !== "pr") continue;
    const key = `${run.itemType}:${run.itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinctItems.push({ itemType: run.itemType, itemId: run.itemId });
    if (distinctItems.length >= maxItems) break;
  }
  if (distinctItems.length === 0) return emptyVerificationActivity();

  const checksPerItem = await Promise.all(
    distinctItems.map(async (item): Promise<VerificationCheckItem[]> => {
      try {
        if (item.itemType === "task") {
          return await fetchRecentVerificationChecks(fetchVerificationChecks, {
            taskId: item.itemId,
          });
        }
        // itemType === "pr" — resolve the "repo#prNumber" dispatch-target
        // reference to its task-store PR record id first.
        const match = item.itemId.match(/^(.+)#(\d+)$/);
        if (!match || !fetchTaskStorePrs) return [];
        const [, repo, prNumber] = match;
        const prResult = await fetchTaskStorePrs(
          new URLSearchParams({ repo, prNumber }),
        );
        const pr = prResult.prs[0];
        if (!pr) return [];
        return await fetchRecentVerificationChecks(fetchVerificationChecks, {
          prId: pr.id,
        });
      } catch {
        return [];
      }
    }),
  );

  const counts: Record<string, number> = {};
  const byCheckName: Record<string, Record<string, number>> = {};
  const byRepo: Record<string, Record<string, number>> = {};
  const environmentalByRepo: Record<string, Record<string, number>> = {};
  let totalChecks = 0;
  for (const checks of checksPerItem) {
    for (const check of checks) {
      counts[check.status] = (counts[check.status] ?? 0) + 1;
      const statusCounts = byCheckName[check.checkName] ?? {};
      statusCounts[check.status] = (statusCounts[check.status] ?? 0) + 1;
      byCheckName[check.checkName] = statusCounts;

      const repoStatusCounts = byRepo[check.repo] ?? {};
      repoStatusCounts[check.status] =
        (repoStatusCounts[check.status] ?? 0) + 1;
      byRepo[check.repo] = repoStatusCounts;

      if (check.reasonCategory) {
        const repoReasonCounts = environmentalByRepo[check.repo] ?? {};
        repoReasonCounts[check.reasonCategory] =
          (repoReasonCounts[check.reasonCategory] ?? 0) + 1;
        environmentalByRepo[check.repo] = repoReasonCounts;
      }

      totalChecks++;
    }
  }
  if (totalChecks === 0) return emptyVerificationActivity();

  return {
    totalChecks,
    itemCount: distinctItems.length,
    counts,
    byCheckName,
    byRepo,
    environmentalByRepo,
  };
}
