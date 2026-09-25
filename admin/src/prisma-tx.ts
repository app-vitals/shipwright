/**
 * agent/src/prisma-tx.ts
 * Shared type for service methods that can optionally participate in a
 * caller-supplied interactive Prisma transaction (APA-1.1).
 *
 * A method that normally writes via `this.prisma` (the top-level PrismaClient)
 * accepts this as an optional trailing parameter, defaulting to `this.prisma`
 * when omitted. Passing the `tx` argument from `prisma.$transaction(async
 * (tx) => ...)` instead makes that write participate in the caller's
 * transaction — see AgentService.runTransaction() and createAgent() in
 * agents.ts for the orchestrator that drives this.
 *
 * A real `PrismaClient` structurally satisfies this type (it merely omits a
 * handful of methods Prisma disallows inside an interactive transaction —
 * $connect/$disconnect/$on/$use/$extends), so both the top-level client and
 * the `tx` callback argument are valid arguments wherever this type is used.
 */
import type { PrismaClient } from "../prisma/client/client.ts";

export type PrismaTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$use" | "$extends"
>;
