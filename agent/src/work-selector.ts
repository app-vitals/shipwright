/**
 * agent/src/work-selector.ts
 *
 * Pure helper: selectNextWorkItem(tasks, prs) → WorkItem | null
 *
 * Given a list of ready tasks (aged by createdAt) and a list of ready PRs
 * (aged by COALESCE(readyForReviewAt, readyForPatchAt, readyForDeployAt),
 * already filtered by the caller to only the pipeline phases currently
 * enabled), returns the single oldest ready item across both entity types —
 * strict age-based FIFO, no phase-priority bias.
 *
 * Deliberately simple v1 prioritization, expected to evolve. Kept isolated
 * from the loop orchestrator (WL-3.3) so it stays cleanly testable via
 * fixtures.
 *
 * `tasks` is already the ready-only candidate set (task-store's ?ready=true
 * query), so dependency satisfaction is computed server-side before this
 * function ever sees the list — a task is selectable purely on
 * status === "pending" and createdAt age.
 *
 * `prs` is, likewise, already an unclaimed-only candidate set — the
 * check-review/check-patch/check-deploy collectors (LPF-2.2) request only
 * unclaimed PR records from the task-store via its `?ready=true` filter (or,
 * for check-review's specific need to distinguish "no record" from "claimed
 * record", perform an equivalent claim check inline before ever returning a
 * candidate). No local claim-filtering happens in this function — a PR
 * candidate is selectable purely on age, the same trust level task
 * candidates get above.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkTaskCandidate {
  id: string;
  createdAt: string;
  title?: string;
}

export interface WorkPrCandidate {
  id: string;
  age: string;
  phase?: "review" | "patch" | "deploy";
  title?: string;
}

export type WorkItem =
  | { type: "task"; task: WorkTaskCandidate }
  | { type: "pr"; pr: WorkPrCandidate };

/**
 * Full ranked view of a work candidate — used by rankWorkItems() below. Task
 * candidates are synthetically tagged phase: "dev-task" (WorkTaskCandidate
 * itself has no phase field, since it only ever represents the dev-task
 * phase). Every real caller of getReviewCandidates/getPatchCandidates/
 * getDeployCandidates always sets WorkPrCandidate.phase (it's set once at
 * each candidate's single construction site, unconditionally) — so by the
 * time a PR candidate reaches rankWorkItems(), phase is never actually
 * undefined in practice, even though the field's declared type is optional
 * for backward compatibility with existing fixtures/tests. If an
 * unpopulated PR candidate ever did reach this function, it falls back to
 * "review" (documented here rather than silently defaulting elsewhere) —
 * an arbitrary but harmless choice, since ordering (the only thing
 * rankWorkItems is relied on for) is unaffected by phase.
 */
export interface RankedWorkItem {
  type: "task" | "pr";
  id: string;
  title?: string;
  phase: "dev-task" | "review" | "patch" | "deploy";
  age: string;
}

/**
 * Select the single oldest ready item across tasks and PRs.
 * Returns null when nothing is ready.
 *
 * `tasks` is trusted as already-ready (status === "pending" and dependency
 * satisfaction both guaranteed by task-store's ?ready=true endpoint), so
 * selection here is purely age-based — no local status re-check.
 */
export function selectNextWorkItem(
  tasks: WorkTaskCandidate[],
  prs: WorkPrCandidate[],
): WorkItem | null {
  let best: { age: string; item: WorkItem } | null = null;

  for (const task of tasks) {
    if (!best || task.createdAt < best.age) {
      best = { age: task.createdAt, item: { type: "task", task } };
    }
  }

  for (const pr of prs) {
    if (!best || pr.age < best.age) {
      best = { age: pr.age, item: { type: "pr", pr } };
    }
  }

  return best ? best.item : null;
}

/**
 * Age comparator for rankWorkItems() — the same "older ISO timestamp string
 * sorts first" rule selectNextWorkItem() applies inline via its own
 * min-tracking loop (left untouched here per this function's additive scope).
 */
function compareByAge(a: { age: string }, b: { age: string }): number {
  return a.age < b.age ? -1 : a.age > b.age ? 1 : 0;
}

/**
 * Rank ALL ready items (tasks and PRs) oldest-first, across both entity
 * types — the full-list counterpart to selectNextWorkItem()'s single winner.
 * Returns [] when both inputs are empty.
 *
 * Ordering is guaranteed to match calling selectNextWorkItem() repeatedly and
 * removing each winner from its source list, since both apply the same
 * lexicographic ISO-timestamp comparison rule (selectNextWorkItem() inline,
 * this function via compareByAge).
 *
 * Tie-break on equal age is deterministic: tasks are appended to the flat
 * candidate list before PRs, and Array.prototype.sort is a stable sort (ES2019+,
 * guaranteed by the spec and by Bun's engine), so equal-age items keep that
 * build order — i.e. tasks-before-PRs, then original input order within each
 * group. This is an arbitrary but fully deterministic and documented choice;
 * nothing in the caller relies on any particular tie-break beyond
 * determinism itself.
 */
export function rankWorkItems(
  tasks: WorkTaskCandidate[],
  prs: WorkPrCandidate[],
): RankedWorkItem[] {
  const items: RankedWorkItem[] = [
    ...tasks.map(
      (task): RankedWorkItem => ({
        type: "task",
        id: task.id,
        title: task.title,
        phase: "dev-task",
        age: task.createdAt,
      }),
    ),
    ...prs.map(
      (pr): RankedWorkItem => ({
        type: "pr",
        id: pr.id,
        title: pr.title,
        // See RankedWorkItem's doc comment: every real caller always sets
        // phase, so this fallback is unreachable in practice.
        phase: pr.phase ?? "review",
        age: pr.age,
      }),
    ),
  ];

  return items.sort(compareByAge);
}
