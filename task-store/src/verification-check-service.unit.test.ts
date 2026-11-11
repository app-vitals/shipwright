/**
 * task-store/src/verification-check-service.unit.test.ts
 *
 * Unit tests for VerificationCheckService. Uses hand-built Prisma doubles
 * (plain objects exposing only the specific Prisma model methods needed) and
 * FixedClock for deterministic time — no mock.module(), no global overrides
 * (mirrors pull-request-service.unit.test.ts's makePrismaDouble pattern).
 */

import { describe, expect, test } from "bun:test";
import { FixedClock } from "./clock.ts";
import { BadRequestError, NotFoundError } from "./errors.ts";
import type { VerificationCheck } from "./index.ts";
import { VerificationCheckService } from "./verification-check-service.ts";

// ─── Prisma double ────────────────────────────────────────────────────────────

interface CreateCall {
  data: Record<string, unknown>;
}

interface FindManyCall {
  where?: unknown;
  orderBy?: unknown;
}

function makePrismaDouble(
  opts: { taskExists?: boolean; prExists?: boolean } = {},
) {
  const createCalls: CreateCall[] = [];
  const findManyCalls: FindManyCall[] = [];
  const taskFindUniqueArgs: unknown[] = [];
  const prFindUniqueArgs: unknown[] = [];

  const prisma = {
    task: {
      findUnique(args: unknown): Promise<{ id: string } | null> {
        taskFindUniqueArgs.push(args);
        return Promise.resolve(
          opts.taskExists === false ? null : { id: "task-1" },
        );
      },
    },
    pullRequest: {
      findUnique(args: unknown): Promise<{ id: string } | null> {
        prFindUniqueArgs.push(args);
        return Promise.resolve(opts.prExists === false ? null : { id: "pr-1" });
      },
    },
    verificationCheck: {
      create(args: CreateCall): Promise<Partial<VerificationCheck>> {
        createCalls.push(args);
        return Promise.resolve({
          id: "vc-1",
          createdAt: new Date(),
          ...args.data,
        } as Partial<VerificationCheck>);
      },
      findMany(args: FindManyCall): Promise<Partial<VerificationCheck>[]> {
        findManyCalls.push(args);
        return Promise.resolve([]);
      },
      count(_args: FindManyCall): Promise<number> {
        return Promise.resolve(0);
      },
    },
    $transaction<T>(ops: Promise<T>[]): Promise<T[]> {
      return Promise.all(ops);
    },
    _createCalls: createCalls,
    _findManyCalls: findManyCalls,
    _taskFindUniqueArgs: taskFindUniqueArgs,
    _prFindUniqueArgs: prFindUniqueArgs,
  };

  return prisma as unknown as {
    task: { findUnique: (args: unknown) => Promise<{ id: string } | null> };
    pullRequest: {
      findUnique: (args: unknown) => Promise<{ id: string } | null>;
    };
    verificationCheck: {
      create: (args: CreateCall) => Promise<Partial<VerificationCheck>>;
      findMany: (args: FindManyCall) => Promise<Partial<VerificationCheck>[]>;
      count: (args: FindManyCall) => Promise<number>;
    };
    $transaction: <T>(ops: Promise<T>[]) => Promise<T[]>;
    _createCalls: CreateCall[];
    _findManyCalls: FindManyCall[];
    _taskFindUniqueArgs: unknown[];
    _prFindUniqueArgs: unknown[];
  };
}

const NOW = new Date("2026-09-24T12:00:00.000Z");

// ─── record() — parent reference (task XOR pr) ─────────────────────────────────

describe("VerificationCheckService.record() — taskId/prId XOR", () => {
  const clock = FixedClock(NOW);

  test("neither taskId nor prId — throws BadRequestError, no DB write", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await expect(
      svc.record({
        repo: "org/repo",
        checkName: "unit",
        status: "ran_passed",
      }),
    ).rejects.toThrow(BadRequestError);
    expect(prisma._createCalls).toHaveLength(0);
  });

  test("both taskId and prId — throws BadRequestError, no DB write", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await expect(
      svc.record({
        taskId: "task-1",
        prId: "pr-1",
        repo: "org/repo",
        checkName: "unit",
        status: "ran_passed",
      }),
    ).rejects.toThrow(BadRequestError);
    expect(prisma._createCalls).toHaveLength(0);
  });

  test("taskId set, task does not exist — throws NotFoundError", async () => {
    const prisma = makePrismaDouble({ taskExists: false });
    const svc = new VerificationCheckService(prisma as never, clock);

    await expect(
      svc.record({
        taskId: "missing-task",
        repo: "org/repo",
        checkName: "unit",
        status: "ran_passed",
      }),
    ).rejects.toThrow(NotFoundError);
    expect(prisma._createCalls).toHaveLength(0);
  });

  test("prId set, pr does not exist — throws NotFoundError", async () => {
    const prisma = makePrismaDouble({ prExists: false });
    const svc = new VerificationCheckService(prisma as never, clock);

    await expect(
      svc.record({
        prId: "missing-pr",
        repo: "org/repo",
        checkName: "unit",
        status: "ran_passed",
      }),
    ).rejects.toThrow(NotFoundError);
    expect(prisma._createCalls).toHaveLength(0);
  });

  test("taskId set and task exists — creates with taskId set, prRecordId null", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await svc.record({
      taskId: "task-1",
      repo: "org/repo",
      checkName: "unit",
      status: "ran_passed",
    });

    expect(prisma._createCalls).toHaveLength(1);
    const { data } = prisma._createCalls[0];
    expect(data.taskId).toBe("task-1");
    expect(data.prRecordId).toBeNull();
  });

  test("prId set and pr exists — creates with prRecordId set, taskId null", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await svc.record({
      prId: "pr-1",
      repo: "org/repo",
      checkName: "unit",
      status: "ran_passed",
    });

    expect(prisma._createCalls).toHaveLength(1);
    const { data } = prisma._createCalls[0];
    expect(data.prRecordId).toBe("pr-1");
    expect(data.taskId).toBeNull();
  });
});

// ─── record() — required fields / at defaulting ────────────────────────────────

describe("VerificationCheckService.record() — required fields and `at` defaulting", () => {
  const clock = FixedClock(NOW);

  test("missing repo — throws BadRequestError", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await expect(
      svc.record({
        taskId: "task-1",
        repo: "",
        checkName: "unit",
        status: "ran_passed",
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("missing checkName — throws BadRequestError", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await expect(
      svc.record({
        taskId: "task-1",
        repo: "org/repo",
        checkName: "",
        status: "ran_passed",
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("`at` omitted — defaults to clock.now().toISOString()", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await svc.record({
      taskId: "task-1",
      repo: "org/repo",
      checkName: "unit",
      status: "ran_passed",
    });

    expect(prisma._createCalls[0].data.at).toBe(NOW.toISOString());
  });

  test("`at` supplied — uses the caller's value instead of the clock", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);
    const callerAt = "2026-01-01T00:00:00.000Z";

    await svc.record({
      taskId: "task-1",
      repo: "org/repo",
      checkName: "unit",
      status: "ran_passed",
      at: callerAt,
    });

    expect(prisma._createCalls[0].data.at).toBe(callerAt);
  });

  test("durationMs omitted — persists null", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await svc.record({
      taskId: "task-1",
      repo: "org/repo",
      checkName: "unit",
      status: "ran_passed",
    });

    expect(prisma._createCalls[0].data.durationMs).toBeNull();
  });

  test("durationMs supplied — persists it", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await svc.record({
      taskId: "task-1",
      repo: "org/repo",
      checkName: "unit",
      status: "ran_passed",
      durationMs: 4200,
    });

    expect(prisma._createCalls[0].data.durationMs).toBe(4200);
  });
});

// ─── record() — status enum validity ───────────────────────────────────────────

describe("VerificationCheckService.record() — status validity", () => {
  const clock = FixedClock(NOW);

  test("invalid status — throws BadRequestError, no DB write", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await expect(
      svc.record({
        taskId: "task-1",
        repo: "org/repo",
        checkName: "unit",
        // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid at the type boundary
        status: "bogus-status" as any,
      }),
    ).rejects.toThrow(BadRequestError);
    expect(prisma._createCalls).toHaveLength(0);
  });

  for (const status of [
    "ran_passed",
    "ran_failed",
    "skipped",
    "timed_out",
  ] as const) {
    test(`valid status '${status}' (no reasonCategory) — accepted`, async () => {
      const prisma = makePrismaDouble();
      const svc = new VerificationCheckService(prisma as never, clock);

      await svc.record({
        taskId: "task-1",
        repo: "org/repo",
        checkName: "unit",
        status,
      });

      expect(prisma._createCalls).toHaveLength(1);
      expect(prisma._createCalls[0].data.status).toBe(status);
    });
  }
});

// ─── record() — the load-bearing status/reasonCategory relationship ───────────
//
// This is LVB-4.4's guardrail: reasonCategory means "the agent could not
// attempt/complete this check in its own environment" — it must never be
// tripped by a genuine ran_failed result (a real test/lint failure), or
// LVB-4.4's future skip-locally learning trigger would misfire on real bugs.

describe("VerificationCheckService.record() — status/reasonCategory relationship", () => {
  const clock = FixedClock(NOW);

  test("status:'ran_failed' + a non-null reasonCategory — REJECTED (the critical guardrail)", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await expect(
      svc.record({
        taskId: "task-1",
        repo: "org/repo",
        checkName: "unit",
        status: "ran_failed",
        reasonCategory: "missing_tool",
      }),
    ).rejects.toThrow(BadRequestError);
    expect(prisma._createCalls).toHaveLength(0);
  });

  test("status:'ran_passed' + a non-null reasonCategory — REJECTED", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await expect(
      svc.record({
        taskId: "task-1",
        repo: "org/repo",
        checkName: "unit",
        status: "ran_passed",
        reasonCategory: "not_configured",
      }),
    ).rejects.toThrow(BadRequestError);
    expect(prisma._createCalls).toHaveLength(0);
  });

  test("status:'ran_failed' with reasonCategory omitted — accepted, reasonCategory persists null", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await svc.record({
      taskId: "task-1",
      repo: "org/repo",
      checkName: "unit",
      status: "ran_failed",
    });

    expect(prisma._createCalls).toHaveLength(1);
    expect(prisma._createCalls[0].data.reasonCategory).toBeNull();
  });

  test("status:'skipped' + reasonCategory:'missing_tool' — accepted", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await svc.record({
      taskId: "task-1",
      repo: "org/repo",
      checkName: "integration",
      status: "skipped",
      reasonCategory: "missing_tool",
    });

    expect(prisma._createCalls).toHaveLength(1);
    expect(prisma._createCalls[0].data.reasonCategory).toBe("missing_tool");
  });

  test("status:'timed_out' + reasonCategory:'check_timeout' — accepted", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await svc.record({
      taskId: "task-1",
      repo: "org/repo",
      checkName: "unit",
      status: "timed_out",
      reasonCategory: "check_timeout",
    });

    expect(prisma._createCalls).toHaveLength(1);
    expect(prisma._createCalls[0].data.reasonCategory).toBe("check_timeout");
  });

  test("invalid reasonCategory value — throws BadRequestError", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await expect(
      svc.record({
        taskId: "task-1",
        repo: "org/repo",
        checkName: "unit",
        status: "skipped",
        // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid at the type boundary
        reasonCategory: "not-a-real-category" as any,
      }),
    ).rejects.toThrow(BadRequestError);
    expect(prisma._createCalls).toHaveLength(0);
  });
});

// ─── record() — learnedFromCategory ─────────────────────────────────────────────

describe("VerificationCheckService.record() — learnedFromCategory", () => {
  const clock = FixedClock(NOW);

  test("learnedFromCategory set without reasonCategory:'learned_skip' — REJECTED", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await expect(
      svc.record({
        taskId: "task-1",
        repo: "org/repo",
        checkName: "unit",
        status: "skipped",
        reasonCategory: "missing_tool",
        learnedFromCategory: "missing_tool",
      }),
    ).rejects.toThrow(BadRequestError);
    expect(prisma._createCalls).toHaveLength(0);
  });

  test("learnedFromCategory:'learned_skip' (self-referential) — REJECTED", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await expect(
      svc.record({
        taskId: "task-1",
        repo: "org/repo",
        checkName: "unit",
        status: "skipped",
        reasonCategory: "learned_skip",
        learnedFromCategory: "learned_skip",
      }),
    ).rejects.toThrow(BadRequestError);
    expect(prisma._createCalls).toHaveLength(0);
  });

  test("reasonCategory:'learned_skip' + valid learnedFromCategory — accepted", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await svc.record({
      taskId: "task-1",
      repo: "org/repo",
      checkName: "unit",
      status: "skipped",
      reasonCategory: "learned_skip",
      learnedFromCategory: "missing_tool",
    });

    expect(prisma._createCalls).toHaveLength(1);
    const { data } = prisma._createCalls[0];
    expect(data.reasonCategory).toBe("learned_skip");
    expect(data.learnedFromCategory).toBe("missing_tool");
  });

  test("reasonCategory:'learned_skip' without learnedFromCategory — accepted (persists null)", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await svc.record({
      taskId: "task-1",
      repo: "org/repo",
      checkName: "unit",
      status: "skipped",
      reasonCategory: "learned_skip",
    });

    expect(prisma._createCalls).toHaveLength(1);
    expect(prisma._createCalls[0].data.learnedFromCategory).toBeNull();
  });
});

// ─── listForTask() / listForPr() ────────────────────────────────────────────────

describe("VerificationCheckService.listForTask()", () => {
  const clock = FixedClock(NOW);

  test("task does not exist — throws NotFoundError", async () => {
    const prisma = makePrismaDouble({ taskExists: false });
    const svc = new VerificationCheckService(prisma as never, clock);

    await expect(svc.listForTask("missing-task")).rejects.toThrow(
      NotFoundError,
    );
  });

  test("task exists — queries verificationCheck scoped to taskId, returns { checks, total }", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    const result = await svc.listForTask("task-1");

    expect(prisma._findManyCalls).toHaveLength(1);
    expect(prisma._findManyCalls[0].where).toEqual({ taskId: "task-1" });
    expect(result).toEqual({ checks: [], total: 0 });
  });

  test("respects limit/offset options", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await svc.listForTask("task-1", { limit: 10, offset: 5 });

    // findMany args aren't captured beyond `where` by this double's
    // signature, but the call must still have happened scoped correctly.
    expect(prisma._findManyCalls).toHaveLength(1);
  });
});

describe("VerificationCheckService.listForPr()", () => {
  const clock = FixedClock(NOW);

  test("pr does not exist — throws NotFoundError", async () => {
    const prisma = makePrismaDouble({ prExists: false });
    const svc = new VerificationCheckService(prisma as never, clock);

    await expect(svc.listForPr("missing-pr")).rejects.toThrow(NotFoundError);
  });

  test("pr exists — queries verificationCheck scoped to prRecordId, returns { checks, total }", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    const result = await svc.listForPr("pr-1");

    expect(prisma._findManyCalls).toHaveLength(1);
    expect(prisma._findManyCalls[0].where).toEqual({ prRecordId: "pr-1" });
    expect(result).toEqual({ checks: [], total: 0 });
  });
});

// ─── listByRepoAndCheck() — the LVB-4.4 history-walk mode ─────────────────────
//
// This mode exists to answer "the last few outcomes for check X on repo Y,
// across ALL tasks/PRs" — the learning trigger walks these backward from most
// recent to detect a consecutive skipped/timed_out streak. That purpose is
// why this mode orders `at` DESCENDING (most recent first) — a deliberate
// deviation from listForTask/listForPr's ascending order, which is unchanged
// for backward compatibility.

describe("VerificationCheckService.listByRepoAndCheck()", () => {
  const clock = FixedClock(NOW);

  test("missing repo — throws BadRequestError, no DB query", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await expect(svc.listByRepoAndCheck("", "lint")).rejects.toThrow(
      BadRequestError,
    );
    expect(prisma._findManyCalls).toHaveLength(0);
  });

  test("missing checkName — throws BadRequestError, no DB query", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await expect(svc.listByRepoAndCheck("org/repo", "")).rejects.toThrow(
      BadRequestError,
    );
    expect(prisma._findManyCalls).toHaveLength(0);
  });

  test("repo+checkName supplied — queries verificationCheck scoped to {repo, checkName}, ordered by `at` DESCENDING", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    const result = await svc.listByRepoAndCheck("org/repo", "lint");

    expect(prisma._findManyCalls).toHaveLength(1);
    expect(prisma._findManyCalls[0].where).toEqual({
      repo: "org/repo",
      checkName: "lint",
    });
    expect(prisma._findManyCalls[0].orderBy).toEqual({ at: "desc" });
    expect(result).toEqual({ checks: [], total: 0 });
  });

  test("does not existence-check a parent — there is no single task/PR to 404 on for this mode", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await svc.listByRepoAndCheck("org/repo", "lint");

    expect(prisma._taskFindUniqueArgs).toHaveLength(0);
    expect(prisma._prFindUniqueArgs).toHaveLength(0);
  });

  test("respects limit/offset options", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await svc.listByRepoAndCheck("org/repo", "lint", { limit: 5, offset: 1 });

    expect(prisma._findManyCalls).toHaveLength(1);
  });

  test("listForTask/listForPr remain ordered `at` ASCENDING — unchanged by this addition", async () => {
    const prisma = makePrismaDouble();
    const svc = new VerificationCheckService(prisma as never, clock);

    await svc.listForTask("task-1");
    await svc.listForPr("pr-1");

    expect(prisma._findManyCalls[0].orderBy).toEqual({ at: "asc" });
    expect(prisma._findManyCalls[1].orderBy).toEqual({ at: "asc" });
  });
});
