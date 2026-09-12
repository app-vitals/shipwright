/**
 * agent/src/check-plan.ts
 *
 * PDR-4.1 — candidate provider for the autonomous plan-session phase, the
 * fifth phase dispatched by the shipwright-loop orchestrator.
 *
 * Mirrors check-dev-task.ts exactly in shape (a Deps interface, a pure
 * candidate mapper, an async collector, and a buildProductionDeps() wiring
 * over createTaskStoreClient) — but queries a different slice of the task
 * store. Where dev-task asks for `?ready=true` (dependency-resolved work
 * items), this phase asks for `?autonomousPlanSession=true&status=pending`:
 * PRD tasks that a human flagged for autonomous planning and that nobody has
 * picked up yet. These are the tasks PDR-3.1's autonomous plan-session mode
 * consumes, and they are deliberately NOT filtered by `ready` — a PRD task
 * awaiting planning has no dependency graph to resolve.
 *
 * Unlike dev-task's bare `/shipwright:dev-task {id}` dispatch, the plan
 * phase's command contract is
 * `/shipwright:plan-session {repo} {session} --autonomous {task-id}` (see
 * plugins/shipwright/commands/plan-session.md), so each candidate carries the
 * task record's own `repo`/`session` through to the orchestrator. A task
 * missing either one cannot produce a well-formed dispatch, so it does not
 * qualify and is dropped here — candidate providers are authoritative on what
 * qualifies (see plugins/shipwright/CLAUDE.md's Candidate Selection Contract),
 * and letting an un-dispatchable task into the merged pool would just have it
 * win FIFO and get skipped every tick.
 *
 * Claiming is unchanged from dev-task's: the orchestrator pre-claims the
 * winning task via the same atomic `POST /tasks/{id}/claim`, so two concurrent
 * loop ticks can never double-process the same PRD task.
 */

import { createTaskStoreClient } from "./check-helpers.ts";
import type { Task } from "./check-helpers.ts";
import { type Clock, SystemClock } from "./clock.ts";
import type { WorkTaskCandidate } from "./work-selector.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CheckPlanDeps {
  /** Flagged, still-pending PRD tasks awaiting an autonomous plan session. */
  getAutonomousPlanTasks: () => Promise<Task[]>;
  clock: Clock;
  /** This agent's own task-store id. */
  agentId: string;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

/** True when a string field is present and not blank/whitespace-only. */
function isPresent(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function toWorkTaskCandidate(task: Task): WorkTaskCandidate {
  return {
    id: task.id,
    createdAt: task.createdAt ?? "",
    title: task.title,
    phase: "plan",
    repo: task.repo,
    session: task.session,
  };
}

/**
 * Collect all autonomous plan-session candidates from the task store.
 *
 * Returns the full flagged-and-pending set as WorkTaskCandidate[] (minus any
 * task that can't produce a well-formed dispatch) — never a single match,
 * never {exit, output}, matching getDevTaskCandidates's contract so the
 * selector sees a complete pool to pick the globally-oldest item from.
 */
export async function getPlanCandidates(
  deps: CheckPlanDeps,
): Promise<WorkTaskCandidate[]> {
  const tasks = await deps.getAutonomousPlanTasks();
  const candidates: WorkTaskCandidate[] = [];
  for (const task of tasks) {
    if (!isPresent(task.repo) || !isPresent(task.session)) {
      console.warn(
        `[check-plan] skipping ${task.id} — an autonomous plan-session task needs both repo and session to build its dispatch command`,
      );
      continue;
    }
    candidates.push(toWorkTaskCandidate(task));
  }
  return candidates;
}

// ─── Production deps ──────────────────────────────────────────────────────────

export function buildProductionDeps(): CheckPlanDeps {
  const client = createTaskStoreClient();
  const agentId = (process.env.SHIPWRIGHT_AGENT_ID ?? "").trim();
  if (!agentId) {
    process.stderr.write("error: SHIPWRIGHT_AGENT_ID is required\n");
    process.exit(1);
  }

  return {
    getAutonomousPlanTasks: () =>
      client.query(
        new URLSearchParams({
          autonomousPlanSession: "true",
          status: "pending",
        }),
      ),
    clock: SystemClock(),
    agentId,
  };
}
