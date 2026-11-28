/**
 * plugins/shipwright/scripts/error-patrol/repo-filter.ts
 *
 * Testable core of the per-repo error-scan (PCR-3.4): fetch unresolved Sentry
 * issues, keep only those whose Sentry project maps to the named repo, diff
 * them against the repo's prior PatrolFindings, and return the result file the
 * cron-run-recorder posts (outcome, metrics, machineState, findings).
 *
 * - fetch is injected; nothing is read from or written to the filesystem.
 * - Issues whose project has no mapping are counted in `metrics.unmapped` and
 *   dropped; issues mapped to a different repo are counted in
 *   `metrics.other_repo`. Neither produces a finding, so neither can get a task.
 * - Never logs or returns the auth token.
 */

export interface SentryDeps {
  fetchFn: typeof fetch;
  org: string;
  token: string;
  /** Defaults to https://sentry.io */
  baseUrl?: string;
}

export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  permalink: string;
  count: number;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  /** Sentry project slug. */
  project: string;
}

/** Sentry project slug -> `org/repo`, or null when the project is unmapped. */
export type ProjectRepoMap = Record<string, string | null>;

export interface PriorFinding {
  fingerprint: string;
  status: string;
  detail?: { count?: number } | null;
}

export interface FindingRecord {
  fingerprint: string;
  status: "open" | "resolved";
  detail: Record<string, unknown>;
}

export interface ScanResult {
  outcome: "ok" | "no_op";
  metrics: {
    new: number;
    regressed: number;
    unchanged: number;
    resolved: number;
    unmapped: number;
    other_repo: number;
  };
  machineState: { projectRepoMap: ProjectRepoMap };
  findings: FindingRecord[];
}

const NEXT_RE = /<[^>]*>;\s*rel="next";\s*results="true";\s*cursor="([^"]+)"/;

export async function fetchUnresolvedIssues(
  deps: SentryDeps,
): Promise<SentryIssue[]> {
  const base = deps.baseUrl ?? "https://sentry.io";
  const issues: SentryIssue[] = [];
  let cursor: string | null = null;
  do {
    const url: string =
      `${base}/api/0/organizations/${encodeURIComponent(deps.org)}/issues/?query=${encodeURIComponent("is:unresolved")}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const res: Response = await deps.fetchFn(url, {
      headers: { Authorization: `Bearer ${deps.token}` },
    });
    if (!res.ok)
      throw new Error(`Sentry issues fetch failed: HTTP ${res.status}`);
    const page = (await res.json()) as Array<Record<string, unknown>>;
    for (const raw of page) {
      const project = raw.project as { slug?: string } | undefined;
      issues.push({
        id: String(raw.id),
        shortId: String(raw.shortId ?? ""),
        title: String(raw.title ?? ""),
        culprit: String(raw.culprit ?? ""),
        permalink: String(raw.permalink ?? ""),
        count: Number(raw.count ?? 0),
        userCount: Number(raw.userCount ?? 0),
        firstSeen: String(raw.firstSeen ?? ""),
        lastSeen: String(raw.lastSeen ?? ""),
        project: project?.slug ?? "",
      });
    }
    cursor = NEXT_RE.exec(res.headers.get("Link") ?? "")?.[1] ?? null;
  } while (cursor);
  return issues;
}

export interface FilterResult {
  kept: SentryIssue[];
  unmapped: number;
  otherRepo: number;
}

export function filterIssuesForRepo(
  issues: SentryIssue[],
  map: ProjectRepoMap,
  repo: string,
): FilterResult {
  const kept: SentryIssue[] = [];
  let unmapped = 0;
  let otherRepo = 0;
  for (const issue of issues) {
    const mapped = map[issue.project];
    if (!mapped) unmapped++;
    else if (mapped.toLowerCase() !== repo.toLowerCase()) otherRepo++;
    else kept.push(issue);
  }
  return { kept, unmapped, otherRepo };
}

const toDetail = (i: SentryIssue, repo: string): Record<string, unknown> => ({
  shortId: i.shortId,
  title: i.title,
  culprit: i.culprit,
  permalink: i.permalink,
  project: i.project,
  repo,
  count: i.count,
  userCount: i.userCount,
  firstSeen: i.firstSeen,
  lastSeen: i.lastSeen,
});

export async function scanRepo(
  deps: SentryDeps,
  opts: { repo: string; projectRepoMap: ProjectRepoMap; prior: PriorFinding[] },
): Promise<ScanResult> {
  const issues = await fetchUnresolvedIssues(deps);
  const { kept, unmapped, otherRepo } = filterIssuesForRepo(
    issues,
    opts.projectRepoMap,
    opts.repo,
  );
  const prior = new Map(opts.prior.map((p) => [p.fingerprint, p]));
  const metrics = {
    new: 0,
    regressed: 0,
    unchanged: 0,
    resolved: 0,
    unmapped,
    other_repo: otherRepo,
  };
  const findings: FindingRecord[] = [];
  const seen = new Set<string>();

  for (const issue of kept) {
    seen.add(issue.id);
    const before = prior.get(issue.id);
    if (!before) metrics.new++;
    else if (
      before.status !== "open" ||
      issue.count > (before.detail?.count ?? 0)
    )
      metrics.regressed++;
    else metrics.unchanged++;
    findings.push({
      fingerprint: issue.id,
      status: "open",
      detail: toDetail(issue, opts.repo),
    });
  }
  for (const p of opts.prior) {
    if (p.status === "open" && !seen.has(p.fingerprint)) {
      metrics.resolved++;
      findings.push({
        fingerprint: p.fingerprint,
        status: "resolved",
        detail: { ...(p.detail ?? {}), repo: opts.repo },
      });
    }
  }

  const changed = metrics.new + metrics.regressed + metrics.resolved > 0;
  return {
    outcome: changed ? "ok" : "no_op",
    metrics,
    machineState: { projectRepoMap: opts.projectRepoMap },
    findings,
  };
}
