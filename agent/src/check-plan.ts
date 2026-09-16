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
 * items), this phase asks for `?autonomousPlanSession=true&status=pending`
 * (TKD-1.1 — the legacy spelling is what the query still sends during the
 * transition window; see buildPrdTaskQuery's doc comment for why): PRD tasks
 * flagged for autonomous planning that nobody has picked up yet. These are PDR-3.1's
 * autonomous plan-session mode consumes, and they are deliberately NOT
 * filtered by `ready` — a PRD task awaiting planning has no dependency graph
 * to resolve, and `?ready=true` excludes the whole `kind: "prd"` slice anyway.
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

import {
  createTaskStoreClient,
  isTaskBlockedForDispatch,
} from "./check-helpers.ts";
import type { Task } from "./check-helpers.ts";
import { type Clock, SystemClock } from "./clock.ts";
import type { WorkTaskCandidate } from "./work-selector.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CheckPlanDeps {
  /** `kind: "prd"`, still-pending tasks awaiting an autonomous plan session. */
  getPrdTasks: () => Promise<Task[]>;
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
  const tasks = await deps.getPrdTasks();
  const candidates: WorkTaskCandidate[] = [];
  for (const task of tasks) {
    // Human-escalation gate, matching every other candidate provider:
    // check-review/check-patch/check-deploy call isTaskBlockedForDispatch()
    // on the linked task, and check-dev-task gets the equivalent for free
    // from task-store's ?ready=true filter (ready.ts drops hitl === true).
    // buildPrdTaskQuery()'s query below (see its doc comment) has no
    // such gate, so a task a human escalated with `hitl: true` while leaving
    // it `pending` would otherwise be claimed and dispatched into an
    // autonomous plan session.
    //
    // Filtered here in the mapper rather than via a `hitl=false` query
    // param on purpose: Task.hitl is nullable (`Boolean?`, no default), and
    // the task-store's hitl filter is a strict equality match in both code
    // paths (task-service.ts's matchesTaskFilters and its Prisma `where`),
    // so `?hitl=false` would drop every task whose hitl is NULL — i.e.
    // essentially the entire queue. `isTaskBlockedForDispatch` only rejects
    // the explicit `hitl === true` (and `status === "blocked"`, which this
    // query already excludes, kept for defense in depth).
    if (isTaskBlockedForDispatch(task)) {
      console.warn(
        `[check-plan] skipping ${task.id} — escalated to a human (hitl/blocked), not eligible for autonomous dispatch`,
      );
      continue;
    }
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

/**
 * The task-store query that defines this phase's pool (TKD-1.1).
 *
 * Exported so its shape is unit-testable without standing up a task-store
 * client: this one query defines the entire plan pool, and getting it wrong
 * silently empties the phase (or, worse, silently widens it to every pending
 * task).
 *
 * `kind=prd` is the current spelling of what used to be
 * `autonomousPlanSession=true`, but for the transition window the query sends
 * the LEGACY spelling alone, on purpose. Three constraints force that choice:
 *
 *  1. The task-store cannot express an OR across two filter params —
 *     TaskService.list() drops every supplied filter onto one Prisma `where`
 *     object, so `?kind=prd&autonomousPlanSession=true` is a strict AND.
 *  2. That AND orphans the one row shape this transition window actually
 *     produces. An old task-store pod writing `autonomousPlanSession: true`
 *     leaves `kind` at the migration's `dev` default; ready.ts correctly
 *     excludes that row from the dev-task pool (`kind === "prd" ||
 *     autonomousPlanSession === true`), and an AND-ed query would exclude it
 *     from the plan pool too — a PRD task invisible to both providers, with
 *     nothing to back-fill `kind` and no error to notice.
 *  3. A `kind`-only query is worse still: the list-query schema ignores params
 *     it doesn't recognize rather than rejecting them, so against a task-store
 *     that predates TKD-1.1 it degrades to a bare `?status=pending` and makes
 *     EVERY pending task a plan candidate — which loop-orchestrator's dedupe
 *     then resolves in the plan phase's favor, dispatching ordinary dev tasks
 *     as `/shipwright:plan-session --autonomous`.
 *
 * The legacy flag alone has none of those failure modes. On a new task-store
 * it is an exact match for the `kind: "prd"` slice — normalizeTaskKind()
 * forces the pair to agree on every write path and the TKD-1.1 migration
 * back-filled existing rows, so `kind='prd'` and `autonomousPlanSession=true`
 * select the same rows — and it additionally picks up the mid-rollout
 * divergence row from (2). On an old task-store it is the only filter that
 * narrows the pool at all. It is also the exact complement of ready.ts's
 * exclusion, so the plan and dev-task pools stay disjoint either way.
 *
 * Switch this to `kind=prd` (dropping the legacy param) once every deployed
 * task-store honors `?kind=` — at which point no divergence row can be
 * written, and the rationale above collapses.
 */
export function buildPrdTaskQuery(): URLSearchParams {
  return new URLSearchParams({
    autonomousPlanSession: "true",
    status: "pending",
  });
}

export function buildProductionDeps(): CheckPlanDeps {
  const client = createTaskStoreClient();
  const agentId = (process.env.SHIPWRIGHT_AGENT_ID ?? "").trim();
  if (!agentId) {
    process.stderr.write("error: SHIPWRIGHT_AGENT_ID is required\n");
    process.exit(1);
  }

  return {
    getPrdTasks: () => client.query(buildPrdTaskQuery()),
    clock: SystemClock(),
    agentId,
  };
}
