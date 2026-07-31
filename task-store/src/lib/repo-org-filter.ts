/**
 * task-store/src/lib/repo-org-filter.ts
 *
 * Pure helper: buildRepoOrgWhere({ orgs, repos }) → a Prisma-compatible where
 * fragment for filtering by org and/or by a list of repos.
 *
 * `repo` is stored as a single `"org/repo"` string on both the `Task` and
 * `PullRequest` models — there's no dedicated org column — so org matching is
 * done via `repo: { startsWith: "<org>/" }`. This mirrors the existing
 * `{ repo: { in: repos } }` pattern used for agent-scoped filtering in
 * task-service.ts and the raw-SQL `= ANY(...)` pattern in
 * pull-request-service.ts's claimNext(), extracted here as a shared,
 * testable building block for both services.
 */

/** Input filters: repos and/or orgs to scope a query to. */
export interface RepoOrgFilter {
  orgs?: string[];
  repos?: string[];
}

/** A single repo-matching clause: exact membership. */
export interface RepoInClause {
  repo: { in: string[] };
}

/** A single org-matching clause: repo prefix match. */
export interface RepoStartsWithClause {
  repo: { startsWith: string };
}

/** The shape returned by buildRepoOrgWhere — usable as a fragment of
 * Prisma.TaskWhereInput or Prisma.PullRequestWhereInput. */
export type RepoOrgWhere =
  | Record<string, never>
  | RepoInClause
  | { OR: RepoStartsWithClause[] }
  | { AND: [RepoInClause, { OR: RepoStartsWithClause[] }] };

/**
 * Builds a Prisma-compatible where fragment from `{ orgs?, repos? }`:
 *   - repos only -> { repo: { in: repos } }
 *   - orgs only  -> { OR: orgs.map(o => ({ repo: { startsWith: `${o}/` } })) }
 *   - both       -> { AND: [the repos clause, the orgs OR clause] }
 *   - neither    -> {}
 *
 * Empty arrays are treated the same as absent.
 */
export function buildRepoOrgWhere(
  filter: RepoOrgFilter = {},
): RepoOrgWhere {
  const orgs = filter.orgs?.length ? filter.orgs : undefined;
  const repos = filter.repos?.length ? filter.repos : undefined;

  const repoClause: RepoInClause | undefined = repos
    ? { repo: { in: repos } }
    : undefined;
  const orgClause: { OR: RepoStartsWithClause[] } | undefined = orgs
    ? { OR: orgs.map((org) => ({ repo: { startsWith: `${org}/` } })) }
    : undefined;

  if (repoClause && orgClause) return { AND: [repoClause, orgClause] };
  if (repoClause) return repoClause;
  if (orgClause) return orgClause;
  return {};
}
