/**
 * chat/src/token-service.integration.test.ts
 * Integration tests for ChatTokenService — Prisma-backed CRUD for scoped tokens.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_CHAT to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { FixedClock } from "./clock.ts";
import { ChatTokenService } from "./token-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_CHAT;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    // TEST_DB is guaranteed set — the describe block is skipped otherwise.
    datasources: { db: { url: TEST_DB as string } },
  });
}

describeOrSkip("ChatTokenService (integration)", () => {
  let prisma: PrismaClient;
  let service: ChatTokenService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.chatToken.deleteMany();
    service = new ChatTokenService(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  // ─── create() ───────────────────────────────────────────────────────────────

  describe("create()", () => {
    it("persists a token with defaults when optional fields are omitted", async () => {
      const { token, rawToken } = await service.create();

      expect(rawToken).toMatch(/^[0-9a-f]{64}$/);
      const read = await prisma.chatToken.findUnique({ where: { id: token.id } });
      expect(read).not.toBeNull();
      expect(read?.label).toBeNull();
      expect(read?.agentId).toBeNull();
      expect(read?.revokedAt).toBeNull();
      expect(read?.token).not.toBe(rawToken);
    });

    it("persists a token with label and agentId populated", async () => {
      const { token } = await service.create("ci token", "agent-1");

      const read = await prisma.chatToken.findUnique({ where: { id: token.id } });
      expect(read?.label).toBe("ci token");
      expect(read?.agentId).toBe("agent-1");
    });

    it("generates a distinct raw token and hash on every call", async () => {
      const first = await service.create();
      const second = await service.create();

      expect(first.rawToken).not.toBe(second.rawToken);
      expect(first.token.token).not.toBe(second.token.token);
    });
  });

  // ─── validate() ─────────────────────────────────────────────────────────────

  describe("validate()", () => {
    it("returns id and agentId for a valid, non-revoked token", async () => {
      const { token, rawToken } = await service.create("label", "agent-1");

      const result = await service.validate(rawToken);
      expect(result).toEqual({ id: token.id, agentId: "agent-1" });
    });

    it("returns null for an unknown raw token", async () => {
      const result = await service.validate("does-not-exist");
      expect(result).toBeNull();
    });

    it("returns null for an empty raw token", async () => {
      const result = await service.validate("");
      expect(result).toBeNull();
    });

    it("returns null for a revoked token", async () => {
      const { token, rawToken } = await service.create();
      await service.revoke(token.id);

      const result = await service.validate(rawToken);
      expect(result).toBeNull();
    });
  });

  // ─── revoke() ───────────────────────────────────────────────────────────────

  describe("revoke()", () => {
    it("sets revokedAt via the injected clock", async () => {
      const clock = FixedClock(new Date("2026-05-01T10:00:00Z"));
      const svc = new ChatTokenService(prisma, clock);
      const { token } = await svc.create();

      const revoked = await svc.revoke(token.id);
      expect(revoked?.revokedAt).toEqual(new Date("2026-05-01T10:00:00Z"));
    });

    it("returns null for a nonexistent id", async () => {
      const result = await service.revoke("nonexistent-id");
      expect(result).toBeNull();
    });
  });

  // ─── update() ───────────────────────────────────────────────────────────────

  describe("update()", () => {
    it("partial update only touches the fields passed", async () => {
      const { token } = await service.create("original", "agent-1");

      const updated = await service.update(token.id, { label: "renamed" });

      expect(updated?.label).toBe("renamed");
      expect(updated?.agentId).toBe("agent-1");
    });

    it("clears label and agentId to null when the key is present with an undefined value", async () => {
      const { token } = await service.create("has label", "agent-1");

      const updated = await service.update(token.id, {
        label: undefined,
        agentId: undefined,
      });

      expect(updated?.label).toBeNull();
      expect(updated?.agentId).toBeNull();
    });

    it("returns null for a nonexistent id", async () => {
      const result = await service.update("nonexistent-id", { label: "x" });
      expect(result).toBeNull();
    });

    it("throws when updating an already-revoked token", async () => {
      const { token } = await service.create();
      await service.revoke(token.id);

      await expect(
        service.update(token.id, { label: "new" }),
      ).rejects.toThrow("token is revoked");
    });
  });

  // ─── list() ─────────────────────────────────────────────────────────────────

  describe("list()", () => {
    it("returns tokens ordered by createdAt asc", async () => {
      const first = await prisma.chatToken.create({
        data: { token: "hash-1", createdAt: new Date("2026-01-01T00:00:00Z") },
      });
      const second = await prisma.chatToken.create({
        data: { token: "hash-2", createdAt: new Date("2026-01-02T00:00:00Z") },
      });

      const tokens = await service.list();
      expect(tokens.map((t) => t.id)).toEqual([first.id, second.id]);
    });

    it("never exposes the raw token value — only the persisted hash", async () => {
      const { token, rawToken } = await service.create();

      const [listed] = await service.list();
      expect(listed.id).toBe(token.id);
      expect(listed.token).not.toBe(rawToken);
    });
  });

  // ─── seed() ─────────────────────────────────────────────────────────────────

  describe("seed()", () => {
    it("upserts a hashed admin token that validates via the raw value", async () => {
      await service.seed("bootstrap-raw-token");

      const result = await service.validate("bootstrap-raw-token");
      expect(result).not.toBeNull();
      expect(result?.agentId).toBeNull();
    });

    it("is idempotent — seeding the same raw token twice does not duplicate rows", async () => {
      await service.seed("bootstrap-raw-token");
      await service.seed("bootstrap-raw-token");

      const tokens = await service.list();
      expect(tokens.length).toBe(1);
    });

    it("no-ops when rawToken is empty", async () => {
      await service.seed("");

      const tokens = await service.list();
      expect(tokens.length).toBe(0);
    });
  });
});
