/**
 * chat/src/token-service.ts
 * ChatTokenService — scoped API tokens for chat service authentication.
 *
 * The raw token (64-char hex) is returned once at creation; only the SHA-256
 * hash is persisted. Validation is O(1) via the unique index on `token`.
 */

import { createHash, randomBytes } from "node:crypto";
import { type Clock, SystemClock } from "./clock.ts";
import type { PrismaClient, ChatToken } from "./index.ts";

export type { ChatToken };

export interface ChatTokenValidated {
  /** The ChatToken row id. */
  id: string;
  /** null = admin token; set = agent token scoped to this agent ID. */
  agentId: string | null;
}

/** The subset of ChatTokenService the auth middleware and routes depend on. */
export interface ChatTokenServiceLike {
  create(
    label?: string,
    agentId?: string,
  ): Promise<{ token: ChatToken; rawToken: string }>;
  validate(raw: string): Promise<ChatTokenValidated | null>;
  revoke(tokenId: string): Promise<ChatToken | null>;
  list(): Promise<ChatToken[]>;
  update(
    tokenId: string,
    data: { label?: string; agentId?: string },
  ): Promise<ChatToken | null>;
  seed(rawToken: string): Promise<void>;
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function generateRawToken(): string {
  return randomBytes(32).toString("hex");
}

export class ChatTokenService implements ChatTokenServiceLike {
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
    agentId?: string,
  ): Promise<{ token: ChatToken; rawToken: string }> {
    const rawToken = generateRawToken();
    const hashed = hashToken(rawToken);
    const token = await this.prisma.chatToken.create({
      data: { token: hashed, label: label ?? null, agentId: agentId ?? null },
    });
    return { token, rawToken };
  }

  /**
   * Validate a raw token. Returns { id, agentId } when valid and not revoked,
   * or null when the token is unknown or revoked.
   */
  async validate(raw: string): Promise<ChatTokenValidated | null> {
    if (!raw) return null;
    const hashed = hashToken(raw);
    const record = await this.prisma.chatToken.findUnique({
      where: { token: hashed },
    });
    if (!record || record.revokedAt !== null) return null;
    return { id: record.id, agentId: record.agentId };
  }

  /**
   * Revoke a token by id. Returns the updated record, or null if not found.
   * Re-throws all errors other than Prisma's "record not found" (P2025).
   */
  async revoke(tokenId: string): Promise<ChatToken | null> {
    try {
      return await this.prisma.chatToken.update({
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

  /**
   * Update a token's label and/or agentId. Returns the updated record, or null if not found.
   * Throws an error if the token is already revoked.
   * Re-throws all errors other than Prisma's "record not found" (P2025).
   */
  async update(
    tokenId: string,
    data: { label?: string; agentId?: string },
  ): Promise<ChatToken | null> {
    try {
      const existing = await this.prisma.chatToken.findUnique({
        where: { id: tokenId },
      });

      if (!existing) return null;

      if (existing.revokedAt !== null) {
        const err = new Error("token is revoked");
        (err as { code?: string }).code = "REVOKED";
        throw err;
      }

      const updateData: { label?: string | null; agentId?: string | null } = {};
      if ("label" in data) {
        updateData.label = data.label ?? null;
      }
      if ("agentId" in data) {
        updateData.agentId = data.agentId ?? null;
      }

      return await this.prisma.chatToken.update({
        where: { id: tokenId },
        data: updateData,
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
  async list(): Promise<ChatToken[]> {
    return this.prisma.chatToken.findMany({ orderBy: { createdAt: "asc" } });
  }

  /**
   * Seed a bootstrap admin token. Hashes `rawToken` and upserts it as an admin
   * token (agentId: null) if not already present. Idempotent — safe to call on
   * every startup. No-ops when `rawToken` is empty.
   */
  async seed(rawToken: string): Promise<void> {
    if (!rawToken) return;
    const hashed = hashToken(rawToken);
    await this.prisma.chatToken.upsert({
      where: { token: hashed },
      update: {},
      create: { token: hashed, agentId: null, label: "seed" },
    });
  }
}
