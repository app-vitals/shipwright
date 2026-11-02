/**
 * scripts/platform-bump-branch-guard.ts
 *
 * Protects fix commits on the bump branch (XPF-1.4). platform-release.yml
 * force-pushes chore/platform-release so a newer release replaces an unmerged
 * older bump. That is only safe when the branch holds the bump bot's own
 * commits: a patch pass or a human that pushed fixes to it (as on #4732) would
 * have them silently discarded by a re-dispatch or a newer release. Before the
 * force-push, this lists the commits on the branch (not in main) that the bump
 * bot did not author; any means the run must not push.
 *
 * Usage (CI): bun scripts/platform-bump-branch-guard.ts <base-ref> <branch-ref> [pr-url]
 * Prints `foreign=<n>` and one `commit=<sha> <author> <subject>` line per
 * foreign commit. Exits 1 (with an ::error:: annotation) when n > 0. A missing
 * branch ref is fine: nothing to protect.
 */

import { spawnSync } from "node:child_process";

/** Author emails the bump commit is created with (the workflow's git identity). */
export const BOT_EMAILS: ReadonlySet<string> = new Set([
  "github-actions[bot]@users.noreply.github.com",
  "41898282+github-actions[bot]@users.noreply.github.com",
]);

export interface BranchCommit {
  sha: string;
  authorEmail: string;
  subject: string;
}

/** Commits not authored by the bump bot. */
export function nonBotCommits(commits: BranchCommit[]): BranchCommit[] {
  return commits.filter((c) => !BOT_EMAILS.has(c.authorEmail.toLowerCase()));
}

/** Commits on `branchRef` that are not in `baseRef`; empty when `branchRef` does not exist. */
export function listBranchCommits(
  baseRef: string,
  branchRef: string,
): BranchCommit[] {
  const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", branchRef]);
  if (exists.status !== 0) return [];
  const log = spawnSync(
    "git",
    ["log", "--format=%H%x09%ae%x09%s", `${baseRef}..${branchRef}`],
    { encoding: "utf8" },
  );
  if (log.status !== 0) {
    throw new Error(`git log ${baseRef}..${branchRef} failed: ${log.stderr}`);
  }
  return parseLog(log.stdout);
}

/** Parse `%H<TAB>%ae<TAB>%s` lines. */
export function parseLog(out: string): BranchCommit[] {
  return out
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const [sha = "", authorEmail = "", ...rest] = l.split("\t");
      return { sha, authorEmail, subject: rest.join("\t") };
    });
}

if (import.meta.main) {
  const [baseRef, branchRef, prUrl] = process.argv.slice(2);
  if (!baseRef || !branchRef) {
    console.error("usage: platform-bump-branch-guard.ts <base-ref> <branch-ref> [pr-url]");
    process.exit(2);
  }
  const foreign = nonBotCommits(listBranchCommits(baseRef, branchRef));
  console.log(`foreign=${foreign.length}`);
  for (const c of foreign) {
    console.log(`commit=${c.sha.slice(0, 10)} ${c.authorEmail} ${c.subject}`);
  }
  if (foreign.length > 0) {
    const list = foreign.map((c) => c.sha.slice(0, 10)).join(", ");
    console.log(
      `::error::${branchRef} holds ${foreign.length} commit(s) not authored by the bump bot (${list})${prUrl ? ` on ${prUrl}` : ""}; refusing to force-push over them. Merge or rebase that PR by hand; the PR is left as it is.`,
    );
    process.exit(1);
  }
}
