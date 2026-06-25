/**
 * task-store/src/index.ts
 *
 * Entry point for the Shipwright task-store package. Re-exports the generated
 * PrismaClient and its types so callers depend on @shipwright/task-store rather
 * than reaching into the generated prisma/client directory directly.
 */

export { PrismaClient, Prisma, TaskStatus, PrState, PrReviewState } from "../prisma/client/index.js";
export type { Task, TaskToken, PullRequest } from "../prisma/client/index.js";
export type {
  BlockedByEntry,
  TaskWithBlockedBy,
  TaskListResult,
} from "./task-service.ts";
