/**
 * chat/src/message-service.unit.test.ts
 *
 * Unit tests for MessageService logic that does not need a real DB — verifies
 * that reply() executes as a single atomic prisma.$transaction rather than two
 * independent writes (a partial failure must never leave repliedAt set with no
 * assistant message). Uses an injected Prisma double — no mock.module, no
 * global overrides.
 */

import { describe, expect, it } from "bun:test";
import { FixedClock } from "./clock.ts";
import type { PrismaClient } from "./index.ts";
import { MessageService } from "./message-service.ts";

/**
 * A minimal Prisma double whose message.update/create record their calls and
 * whose $transaction runs the passed operations. reply() is expected to hand a
 * single array of prepared operations to $transaction — so we record whether
 * $transaction was invoked, and whether the two writes ran through it rather
 * than directly.
 */
function makePrismaDouble() {
  const calls: string[] = [];
  const userMessage = {
    id: "user-1",
    threadId: "thread-1",
    role: "user",
    body: "question",
    repliedAt: null,
  };

  // The operation builders return tagged tokens rather than executing eagerly;
  // $transaction is what "runs" them. This models Prisma's lazy PrismaPromise
  // batching: message.update(...)/create(...) inside a $transaction([]) array
  // are prepared, not executed, until $transaction runs.
  const prisma = {
    message: {
      findUnique: async () => userMessage,
      update: (args: unknown) => {
        calls.push("update");
        return { __op: "update", args } as unknown;
      },
      create: (args: unknown) => {
        calls.push("create");
        return { __op: "create", args } as unknown;
      },
    },
    $transaction: async (ops: unknown[]) => {
      calls.push("$transaction");
      // Resolve each prepared op to a representative row.
      return ops.map((op) => {
        const tagged = op as { __op: string };
        if (tagged.__op === "update") {
          return { ...userMessage, repliedAt: new Date() };
        }
        return {
          id: "assistant-1",
          threadId: "thread-1",
          role: "assistant",
          body: "answer",
          errorKind: null,
        };
      });
    },
    calls,
  };
  return prisma;
}

describe("MessageService.reply — atomicity", () => {
  it("executes the user-update and assistant-create as a single $transaction", async () => {
    const prisma = makePrismaDouble();
    const svc = new MessageService(
      prisma as unknown as PrismaClient,
      FixedClock(new Date("2026-01-01T00:00:00Z")),
    );

    const result = await svc.reply("user-1", { body: "answer" });

    expect(result).not.toBeNull();
    // $transaction MUST have been called — a Promise.all of two independent
    // writes would never touch it.
    expect(prisma.calls).toContain("$transaction");
    // Both writes were prepared before the transaction ran (batched), not run
    // eagerly as separate awaited promises.
    expect(prisma.calls).toEqual(["update", "create", "$transaction"]);
  });

  it("passes an errorKind through to the created assistant message", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const userMessage = {
      id: "user-1",
      threadId: "thread-1",
      role: "user",
      body: "q",
      repliedAt: null,
    };
    const prisma = {
      message: {
        findUnique: async () => userMessage,
        update: (args: unknown) => ({ __op: "update", args }),
        create: (args: { data: Record<string, unknown> }) => {
          captured.push(args.data);
          return { __op: "create", args };
        },
      },
      $transaction: async (ops: unknown[]) =>
        ops.map((op) => {
          const tagged = op as { __op: string; args?: unknown };
          if (tagged.__op === "update")
            return { ...userMessage, repliedAt: new Date() };
          return {
            id: "assistant-1",
            role: "assistant",
            errorKind: "cancelled",
          };
        }),
    };
    const svc = new MessageService(
      prisma as unknown as PrismaClient,
      FixedClock(new Date("2026-01-01T00:00:00Z")),
    );

    await svc.reply("user-1", { body: "Cancelled.", errorKind: "cancelled" });

    expect(captured[0]?.errorKind).toBe("cancelled");
  });
});
