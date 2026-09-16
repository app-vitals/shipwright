/**
 * task-store/src/index.ts
 *
 * Entry point for the Shipwright task-store package. Re-exports the generated
 * PrismaClient and its types so callers depend on @shipwright/task-store rather
 * than reaching into the generated prisma/client directory directly.
 */

export type {
  PrFinding,
  PullRequest,
  PullRequestEvent,
  Session,
  Task,
  TaskEvent,
  TaskToken,
} from "../prisma/client/client.ts";
export {
  PrFindingDisposition,
  PrFindingSource,
  Prisma,
  PrismaClient,
  PrOrigin,
  PrPhase,
  PrReviewState,
  PrState,
  TaskKind,
  TaskStatus,
} from "../prisma/client/client.ts";
export type {
  BlockedByEntry,
  TaskListResult,
  TaskWithBlockedBy,
} from "./task-service.ts";
