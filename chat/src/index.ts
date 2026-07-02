/**
 * chat/src/index.ts
 *
 * Entry point for the Shipwright chat package. Re-exports the generated
 * PrismaClient and its types so callers depend on @shipwright/chat rather
 * than reaching into the generated prisma/client directory directly.
 */

export { PrismaClient, Prisma } from "../prisma/client/index.js";
export type { ChatToken, Thread, Message } from "../prisma/client/index.js";
