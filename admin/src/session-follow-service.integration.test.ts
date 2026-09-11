/**
 * admin/src/session-follow-service.integration.test.ts
 * Integration tests for SessionFollowService against a real PostgreSQL DB.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { BadRequestError } from "./errors.ts";
import { SessionFollowService } from "./session-follow-service.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    // TEST_DB is guaranteed set — the describe block is skipped otherwise.
    datasources: { db: { url: TEST_DB as string } },
  });
}

describeOrSkip("SessionFollowService (integration)", () => {
  let prisma: PrismaClient;
  let service: SessionFollowService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.sessionFollow.deleteMany();
    await prisma.sessionAlertState.deleteMany();
    await prisma.userNotificationPrefs.deleteMany();
    service = new SessionFollowService(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  // ─── follow ─────────────────────────────────────────────────────────────────

  it("follow() creates a SessionFollow row", async () => {
    const follow = await service.follow("dave@example.com", "sess-1");
    expect(follow.userEmail).toBe("dave@example.com");
    expect(follow.sessionSlug).toBe("sess-1");
    expect(follow.muted).toBe(false);
  });

  it("follow() is idempotent — following the same session twice does not error or duplicate", async () => {
    await service.follow("dave@example.com", "sess-1");
    await service.follow("dave@example.com", "sess-1");
    const rows = await service.listByUser("dave@example.com");
    expect(rows).toHaveLength(1);
  });

  it("follow() un-mutes a previously-muted follow on re-follow", async () => {
    const first = await service.follow("dave@example.com", "sess-1");
    await prisma.sessionFollow.update({
      where: { id: first.id },
      data: { muted: true },
    });
    const second = await service.follow("dave@example.com", "sess-1");
    expect(second.muted).toBe(false);
  });

  // ─── unfollow ───────────────────────────────────────────────────────────────

  it("unfollow() removes the SessionFollow row", async () => {
    await service.follow("dave@example.com", "sess-1");
    await service.unfollow("dave@example.com", "sess-1");
    const rows = await service.listByUser("dave@example.com");
    expect(rows).toHaveLength(0);
  });

  it("unfollow() of a non-existent follow is idempotent (no error)", async () => {
    await expect(
      service.unfollow("dave@example.com", "never-followed"),
    ).resolves.toBeUndefined();
  });

  // ─── listByUser ─────────────────────────────────────────────────────────────

  it("listByUser() returns all sessions a user follows", async () => {
    await service.follow("dave@example.com", "sess-1");
    await service.follow("dave@example.com", "sess-2");
    await service.follow("dan@example.com", "sess-3");

    const rows = await service.listByUser("dave@example.com");
    expect(rows).toHaveLength(2);
    const slugs = rows.map((r) => r.sessionSlug).sort();
    expect(slugs).toEqual(["sess-1", "sess-2"]);
  });

  it("listByUser() returns [] for a user with no follows", async () => {
    expect(await service.listByUser("nobody@example.com")).toEqual([]);
  });

  // ─── getOrCreatePrefs ───────────────────────────────────────────────────────

  it("getOrCreatePrefs() creates a default-valued row on first call", async () => {
    const prefs = await service.getOrCreatePrefs("dave@example.com");
    expect(prefs.userEmail).toBe("dave@example.com");
    expect(prefs.autoFollowSessions).toBe(true);
    expect(prefs.reminderHourLocal).toBe(9);
    expect(prefs.autoFollowSince).toBeNull();
  });

  it("getOrCreatePrefs() returns the existing row on subsequent calls, not a fresh default", async () => {
    await service.updatePrefs("dave@example.com", { reminderHourLocal: 14 });
    const prefs = await service.getOrCreatePrefs("dave@example.com");
    expect(prefs.reminderHourLocal).toBe(14);

    const rows = await prisma.userNotificationPrefs.findMany({
      where: { userEmail: "dave@example.com" },
    });
    expect(rows).toHaveLength(1);
  });

  // ─── updatePrefs ────────────────────────────────────────────────────────────

  it("updatePrefs() upserts prefs for a user with no existing row", async () => {
    const prefs = await service.updatePrefs("dave@example.com", {
      autoFollowSessions: false,
    });
    expect(prefs.autoFollowSessions).toBe(false);
    expect(prefs.reminderHourLocal).toBe(9); // default, untouched
  });

  it("updatePrefs() persists reminderHourLocal = 7", async () => {
    const prefs = await service.updatePrefs("dave@example.com", {
      reminderHourLocal: 7,
    });
    expect(prefs.reminderHourLocal).toBe(7);

    const reloaded = await service.getOrCreatePrefs("dave@example.com");
    expect(reloaded.reminderHourLocal).toBe(7);
  });

  it("updatePrefs() rejects reminderHourLocal = 25 with BadRequestError and does not persist it", async () => {
    await service.getOrCreatePrefs("dave@example.com");
    await expect(
      service.updatePrefs("dave@example.com", { reminderHourLocal: 25 }),
    ).rejects.toBeInstanceOf(BadRequestError);

    const reloaded = await service.getOrCreatePrefs("dave@example.com");
    expect(reloaded.reminderHourLocal).toBe(9);
  });

  it("updatePrefs() rejects a negative reminderHourLocal", async () => {
    await expect(
      service.updatePrefs("dave@example.com", { reminderHourLocal: -1 }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("updatePrefs() rejects a non-integer reminderHourLocal", async () => {
    await expect(
      service.updatePrefs("dave@example.com", { reminderHourLocal: 9.5 }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});
