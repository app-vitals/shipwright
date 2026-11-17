/**
 * task-store/src/github-plan-client.ts
 *
 * Real GitHub REST implementation of PlanDocumentGitHubClient (PLU-2.6).
 * `fetch` is an injectable parameter so tests can replay recorded responses.
 */

import type {
  DefaultBranchFile,
  PlanDocumentGitHubClient,
  PullRequestStatus,
} from "./plan-document-reconciler.ts";

export interface GitHubPlanClientOptions {
  token: string;
  fetch?: typeof fetch;
  apiBase?: string;
}

const PR_URL_RE = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/;

export function createGitHubPlanClient(
  opts: GitHubPlanClientOptions,
): PlanDocumentGitHubClient {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.apiBase ?? "https://api.github.com";

  async function get(path: string): Promise<unknown | null> {
    const res = await doFetch(`${base}${path}`, {
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`GitHub GET ${path} failed: ${res.status}`);
    }
    return res.json();
  }

  const encodePath = (p: string) =>
    p.split("/").map(encodeURIComponent).join("/");

  return {
    async getFileOnDefaultBranch(
      repo,
      path,
    ): Promise<DefaultBranchFile | null> {
      // No `ref` = the repo's default branch.
      const content = await get(`/repos/${repo}/contents/${encodePath(path)}`);
      if (!content) return null;
      const commits = (await get(
        `/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1`,
      )) as { sha: string }[] | null;
      const commitSha = commits?.[0]?.sha ?? null;
      let prUrl: string | null = null;
      if (commitSha) {
        const pulls = (await get(
          `/repos/${repo}/commits/${commitSha}/pulls`,
        )) as { html_url: string; merged_at: string | null }[] | null;
        prUrl = pulls?.find((p) => p.merged_at)?.html_url ?? null;
      }
      return { commitSha, prUrl };
    },

    async getPullRequest(prUrl): Promise<PullRequestStatus | null> {
      const m = PR_URL_RE.exec(prUrl);
      if (!m) return null;
      const pr = (await get(`/repos/${m[1]}/pulls/${m[2]}`)) as {
        state: "open" | "closed";
        merged: boolean;
      } | null;
      return pr ? { state: pr.state, merged: pr.merged } : null;
    },
  };
}

/** Credential lookup: GH_TOKEN (repo convention), then GITHUB_TOKEN. */
export function githubTokenFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return env.GH_TOKEN || env.GITHUB_TOKEN || null;
}
