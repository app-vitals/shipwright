/**
 * chat/src/thread-service.ts
 * ThreadService — CRUD for conversation threads.
 */

import { type Clock, SystemClock } from "./clock.ts";
import type { PrismaClient, Thread } from "./index.ts";

export type { Thread };

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
}

function isPrismaNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "P2025"
  );
}
