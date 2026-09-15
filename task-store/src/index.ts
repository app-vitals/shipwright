/**
 * task-store/src/index.ts
 *
 * Entry point for the Shipwright task-store package. Re-exports the generated
 * PrismaClient and its types so callers depend on @shipwright/task-store rather
 * than reaching into the generated prisma/client directory directly.
 */

export {
  PrismaClient,
  Prisma,
  TaskKind,
  TaskStatus,
  PrState,
  PrReviewState,
  PrPhase,
  PrFindingDisposition,
  PrFindingSource,
} from "../prisma/client/client.ts";
export type {
  Task,
  TaskToken,
  TaskEvent,
  PullRequest,
  PrFinding,
  PullRequestEvent,
  Session,
} from "../prisma/client/client.ts";
export type {
  BlockedByEntry,
  TaskWithBlockedBy,
  TaskListResult,
} from "./task-service.ts";
