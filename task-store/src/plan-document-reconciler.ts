/**
 * task-store/src/plan-document-reconciler.ts
 *
 * PlanDocumentReconciler — nightly sweep that settles PlanDocument rows
 * (PLU-2.6). A document in state `draft` or `pr_open` is checked against
 * GitHub and moved to:
 *   - `merged`    when its file exists on the home repo's default branch
 *   - `abandoned` when its docs PR was closed unmerged AND the file is not on
 *                 the default branch
 * Anything else is left alone (the PR may still be open, or the document was
 * never given a PR). The reconciler changes only `state`, `prUrl` and
 * `commitSha`; `merged` and `abandoned` rows are never examined.
 *
 * GitHub is reached through the injectable `PlanDocumentGitHubClient`
 * interface (a real implementation lives in ./github-plan-client.ts and takes
 * an injectable fetch). With no client — i.e. no GitHub credential — sweep()
 * does nothing and logs that fact once per process.
 *
 * Time comes from the injected `Clock`; main.ts registers sweep() on a 24h
 * interval, like the other reapers.
 */

import { type Clock, SystemClock } from "./clock.ts";
import type { PlanDocumentState, PrismaClient } from "./index.ts";

/** A file found on a repo's default branch. */
export interface DefaultBranchFile {
  /** Commit on the default branch the file was last written at. */
  commitSha: string | null;
  /** URL of the merged PR that introduced that commit, when GitHub reports one. */
  prUrl: string | null;
}

export interface PullRequestStatus {
  state: "open" | "closed";
  merged: boolean;
}

export interface PlanDocumentGitHubClient {
  /** The file on the repo's default branch, or null when it is not there. */
  getFileOnDefaultBranch(
    repo: string,
    path: string,
  ): Promise<DefaultBranchFile | null>;
  /** Status of the PR at `prUrl`, or null when GitHub does not know it (404). */
  getPullRequest(prUrl: string): Promise<PullRequestStatus | null>;
}

export interface ReconcileEvidence {
  /** Result of the default-branch file lookup. */
  file: DefaultBranchFile | null;
  /** PR status, or null when the document has no PR (or GitHub lost it). */
  pr: PullRequestStatus | null;
}

export interface ReconcileDecision {
  state: Extract<PlanDocumentState, "merged" | "abandoned">;
  prUrl: string | null;
  commitSha: string | null;
}

/**
 * Pure decision: given what GitHub says, what should the row become?
 * Returns null when the row should be left as it is.
 */
export function decideDocumentState(
  doc: { prUrl: string | null; commitSha: string | null },
  evidence: ReconcileEvidence,
): ReconcileDecision | null {
  if (evidence.file) {
    return {
      state: "merged",
      prUrl: doc.prUrl ?? evidence.file.prUrl,
      commitSha: evidence.file.commitSha ?? doc.commitSha,
    };
  }
  if (evidence.pr && evidence.pr.state === "closed" && !evidence.pr.merged) {
    return { state: "abandoned", prUrl: doc.prUrl, commitSha: doc.commitSha };
  }
  return null;
}

export interface ReconcileResult {
  examined: number;
  merged: number;
  abandoned: number;
  unchanged: number;
  failed: number;
}

const EMPTY_RESULT = (): ReconcileResult => ({
  examined: 0,
  merged: 0,
  abandoned: 0,
  unchanged: 0,
  failed: 0,
});

export class PlanDocumentReconciler {
  /** When the last sweep that reached GitHub started; null before the first. */
  lastSweepAt: Date | null = null;
  private loggedNoCredential = false;

  constructor(
    private readonly prisma: PrismaClient,
    /** null = no GitHub credential: sweeps are no-ops. */
    private readonly github: PlanDocumentGitHubClient | null,
    private readonly clock: Clock = SystemClock(),
  ) {}

  /** True when a GitHub client is configured. */
  get enabled(): boolean {
    return this.github !== null;
  }

  async sweep(): Promise<ReconcileResult> {
    const result = EMPTY_RESULT();
    if (!this.github) {
      if (!this.loggedNoCredential) {
        this.loggedNoCredential = true;
        console.log(
          "[plan-document-reconciler] no GitHub credential (GH_TOKEN / GITHUB_TOKEN) — planning document reconcile disabled",
        );
      }
      return result;
    }

    this.lastSweepAt = this.clock.now();
    const docs = await this.prisma.planDocument.findMany({
      where: { state: { in: ["draft", "pr_open"] } },
    });

    for (const doc of docs) {
      result.examined++;
      try {
        const file = await this.github.getFileOnDefaultBranch(
          doc.repo,
          doc.path,
        );
        const pr =
          !file && doc.prUrl
            ? await this.github.getPullRequest(doc.prUrl)
            : null;
        const decision = decideDocumentState(doc, { file, pr });
        if (!decision) {
          result.unchanged++;
          continue;
        }
        // Conditional on the row still being open so a concurrent PATCH wins.
        const { count } = await this.prisma.planDocument.updateMany({
          where: { id: doc.id, state: { in: ["draft", "pr_open"] } },
          data: {
            state: decision.state,
            prUrl: decision.prUrl,
            commitSha: decision.commitSha,
          },
        });
        if (count === 0) {
          result.unchanged++;
          continue;
        }
        result[decision.state]++;
        console.log(
          `[plan-document-reconciler] ${doc.repo}:${doc.path} (session "${doc.session}") ${doc.state} -> ${decision.state}`,
        );
      } catch (err) {
        result.failed++;
        console.error(
          `[plan-document-reconciler] failed to reconcile ${doc.repo}:${doc.path}:`,
          err,
        );
      }
    }
    return result;
  }
}
