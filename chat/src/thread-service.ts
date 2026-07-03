/**
 * chat/src/thread-service.ts
 * ThreadService — CRUD for conversation threads.
 */

import { type Clock, SystemClock } from "./clock.ts";
import type { PrismaClient, Thread } from "./index.ts";

export type { Thread };

export interface ThreadStats {
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

export interface ThreadServiceLike {
  create(data: {
    agentId: string;
    memberId?: string;
    title?: string;
  }): Promise<Thread>;

  findById(id: string): Promise<Thread | null>;

  list(filter?: {
    agentId?: string;
    memberId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ threads: Thread[]; total: number }>;

  update(
    id: string,
    data: { title?: string | null; memberId?: string | null },
  ): Promise<Thread | null>;

  delete(id: string): Promise<Thread | null>;

  getStats(thread: Thread): Promise<ThreadStats>;
}

export class ThreadService implements ThreadServiceLike {
  constructor(
    private prisma: PrismaClient,
    private clock: Clock = SystemClock(),
  ) {}

  async create(data: {
    agentId: string;
    memberId?: string;
    title?: string;
  }): Promise<Thread> {
    return this.prisma.thread.create({
      data: {
        agentId: data.agentId,
        memberId: data.memberId ?? null,
        title: data.title ?? null,
      },
    });
  }

  async findById(id: string): Promise<Thread | null> {
    return this.prisma.thread.findUnique({ where: { id } });
  }

  async list(
    filter: {
      agentId?: string;
      memberId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{ threads: Thread[]; total: number }> {
    const where: { agentId?: string; memberId?: string } = {};
    if (filter.agentId !== undefined) where.agentId = filter.agentId;
    if (filter.memberId !== undefined) where.memberId = filter.memberId;

    const limit = Math.min(filter.limit ?? 50, 200);
    const offset = filter.offset ?? 0;

    const [threads, total] = await Promise.all([
      this.prisma.thread.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: limit,
        skip: offset,
      }),
      this.prisma.thread.count({ where }),
    ]);

    return { threads, total };
  }

  async update(
    id: string,
    data: { title?: string | null; memberId?: string | null },
  ): Promise<Thread | null> {
    try {
      return await this.prisma.thread.update({
        where: { id },
        data: {
          ...(data.title !== undefined ? { title: data.title } : {}),
          ...(data.memberId !== undefined ? { memberId: data.memberId } : {}),
          updatedAt: this.clock.now(),
        },
      });
    } catch (err: unknown) {
      if (isPrismaNotFound(err)) return null;
      throw err;
    }
  }

  async delete(id: string): Promise<Thread | null> {
    try {
      return await this.prisma.thread.delete({ where: { id } });
    } catch (err: unknown) {
      if (isPrismaNotFound(err)) return null;
      throw err;
    }
  }

  async getStats(thread: Thread): Promise<ThreadStats> {
    const threadId = thread.id;

    const agg = await this.prisma.message.aggregate({
      where: { threadId },
      _count: { id: true },
      _sum: { costUsd: true },
    });

    // tokens is a JSON blob — can't aggregate in SQL, so sum in JS.
    // NOTE: this loads every message's token blob into memory. For
    // admin-only usage the volume is acceptable, but callers should be
    // aware that threads with thousands of messages will incur proportional
    // memory overhead here.
    const tokenRows = await this.prisma.message.findMany({
      where: { threadId },
      select: { tokens: true },
    });

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    for (const row of tokenRows) {
      const t = row.tokens as {
        input_tokens?: number;
        output_tokens?: number;
      } | null;
      if (t && typeof t === "object") {
        totalInputTokens += t.input_tokens ?? 0;
        totalOutputTokens += t.output_tokens ?? 0;
      }
    }

    return {
      messageCount: agg._count.id,
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd: agg._sum.costUsd ?? 0,
    };
  }
}


function isPrismaNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "P2025"
  );
}
