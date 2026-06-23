/**
 * task-store/src/token-service.ts
 * TaskTokenService — scoped API tokens for task-store authentication.
 *
 * The raw token (64-char hex) is returned once at creation; only the SHA-256
 * hash is persisted. Validation is O(1) via the unique index on `token`.
 */

import { createHash, randomBytes } from "node:crypto";
import { type Clock, SystemClock } from "./clock.ts";
import type { PrismaClient, TaskToken } from "./index.ts";

export type { TaskToken };

export interface TaskTokenValidated {
  /** The TaskToken row id. */
  id: string;
}

/** The subset of TaskTokenService the auth middleware and routes depend on. */
export interface TokenServiceLike {
  create(label?: string): Promise<{ token: TaskToken; rawToken: string }>;
  validate(raw: string): Promise<TaskTokenValidated | null>;
  revoke(tokenId: string): Promise<TaskToken | null>;
  list(): Promise<TaskToken[]>;
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function generateRawToken(): string {
  return randomBytes(32).toString("hex");
}

export class TaskTokenService implements TokenServiceLike {
  constructor(
    private prisma: PrismaClient,
    private clock: Clock = SystemClock(),
  ) {}

  /**
   * Create a new token. Returns the persisted record plus the raw token —
   * the only opportunity to read the raw value.
   */
  async create(
    label?: string,
  ): Promise<{ token: TaskToken; rawToken: string }> {
    const rawToken = generateRawToken();
    const hashed = hashToken(rawToken);
    const token = await this.prisma.taskToken.create({
      data: { token: hashed, label: label ?? null },
    });
    return { token, rawToken };
  }

  /**
   * Validate a raw token. Returns { id } when valid and not revoked,
   * or null when the token is unknown or revoked.
   */
  async validate(raw: string): Promise<TaskTokenValidated | null> {
    if (!raw) return null;
    const hashed = hashToken(raw);
    const record = await this.prisma.taskToken.findUnique({
      where: { token: hashed },
    });
    if (!record || record.revokedAt !== null) return null;
    return { id: record.id };
  }

  /**
   * Revoke a token by id. Returns the updated record, or null if not found.
   * Re-throws all errors other than Prisma's "record not found" (P2025).
   */
  async revoke(tokenId: string): Promise<TaskToken | null> {
    try {
      return await this.prisma.taskToken.update({
        where: { id: tokenId },
        data: { revokedAt: this.clock.now() },
      });
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === "P2025"
      ) {
        return null;
      }
      throw err;
    }
  }

  /** List all tokens (hash + metadata, never the raw value). */
  async list(): Promise<TaskToken[]> {
    return this.prisma.taskToken.findMany({ orderBy: { createdAt: "asc" } });
  }
}
