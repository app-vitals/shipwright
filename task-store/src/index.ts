/**
 * task-store/src/index.ts
 *
 * Entry point for the Shipwright task-store package. Re-exports the generated
 * PrismaClient and its types so callers depend on @shipwright/task-store rather
 * than reaching into the generated prisma/client directory directly.
 */

export { PrismaClient, Prisma, TaskStatus } from "../prisma/client/index.js";
export type { Task, TaskToken } from "../prisma/client/index.js";
