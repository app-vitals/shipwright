/**
 * task-store/src/document-service.unit.test.ts
 *
 * PWE-3.1: DocumentService.register() accepts a caller-owned transaction
 * client so POST /sessions/{slug}/plan can register the plan document in the
 * same transaction as its tasks. Pure control-flow checks with a recording
 * double; the DB behaviour is covered by document-service.integration.test.ts
 * and session-plan.integration.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { DocumentService } from "./document-service.ts";
import type { PrismaClient } from "./index.ts";

function makeRecordingClient(label: string, calls: string[]) {
  return {
    session: {
      createMany: async () => {
        calls.push(`${label}:session.createMany`);
        return { count: 1 };
      },
      updateMany: async () => {
        calls.push(`${label}:session.updateMany`);
        return { count: 1 };
      },
    },
    planDocument: {
      findUnique: async () => {
        calls.push(`${label}:planDocument.findUnique`);
        return null;
      },
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        calls.push(`${label}:planDocument.upsert`);
        return { id: "doc-1", ...create };
      },
    },
  };
}

const PLAN = {
  session: "s",
  kind: "plan" as const,
  repo: "org/home",
  path: "planning/s/PLAN.md",
};

describe("DocumentService.register shared transaction (unit)", () => {
  it("opens its own transaction when no client is passed", async () => {
    const calls: string[] = [];
    let opened = 0;
    const root = {
      ...makeRecordingClient("root", calls),
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        opened++;
        return fn(makeRecordingClient("own-tx", calls));
      },
    } as unknown as PrismaClient;

    const doc = await new DocumentService(root).register(PLAN);
    expect(doc.id).toBe("doc-1");
    expect(opened).toBe(1);
    expect(calls.every((c) => c.startsWith("own-tx:"))).toBe(true);
  });

  it("runs every statement on the caller's client and never opens a transaction", async () => {
    const calls: string[] = [];
    const root = {
      $transaction: async () => {
        throw new Error("must not open a transaction");
      },
    } as unknown as PrismaClient;
    const tx = makeRecordingClient("caller-tx", calls);

    const doc = await new DocumentService(root).register(
      PLAN,
      "default",
      { repos: ["org/home"], accountId: "default" },
      tx as never,
    );
    expect(doc.id).toBe("doc-1");
    expect(doc.number).toBe(1);
    expect(calls).toContain("caller-tx:planDocument.upsert");
    expect(calls).toContain("caller-tx:session.createMany");
    expect(calls.every((c) => c.startsWith("caller-tx:"))).toBe(true);
  });
});
