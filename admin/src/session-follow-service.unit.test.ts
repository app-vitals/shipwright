/**
 * admin/src/session-follow-service.unit.test.ts
 * Unit tests for the pure decision logic in SessionFollowService.updatePrefs —
 * specifically when `autoFollowSince` is stamped. The full CRUD surface is
 * covered against a real DB in session-follow-service.integration.test.ts;
 * this layer exists because the stamping rule is a branch on the *existing*
 * row, which is far cheaper to pin down with an injected Prisma double and a
 * FixedClock than with a live Postgres.
 */

import { describe, expect, it } from "bun:test";
import { FixedClock } from "./clock.ts";
import {
  type SessionFollowPrismaLike,
  SessionFollowService,
  type UserNotificationPrefsRow,
} from "./session-follow-service.ts";

const NOW = new Date("2026-03-02T17:00:00.000Z");
const EPOCH = new Date("2020-01-01T00:00:00.000Z");

function defaultRow(
  userEmail: string,
  overrides: Partial<UserNotificationPrefsRow> = {},
): UserNotificationPrefsRow {
  return {
    userEmail,
    autoFollowSessions: true,
    reminderHourLocal: 9,
    autoFollowSince: null,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...overrides,
  };
}

/** Prefs-only Prisma double — the other models aren't reached by updatePrefs. */
function fakePrisma(seed?: UserNotificationPrefsRow) {
  let row = seed ? { ...seed } : undefined;
  const prisma = {
    userNotificationPrefs: {
      upsert: async ({ where }: { where: { userEmail: string } }) => {
        row ??= defaultRow(where.userEmail);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { userEmail: string };
        data: Partial<UserNotificationPrefsRow>;
      }) => {
        row = { ...(row ?? defaultRow(where.userEmail)), ...data };
        return row;
      },
    },
  } as unknown as SessionFollowPrismaLike;

  return { prisma, current: () => row };
}

describe("SessionFollowService.updatePrefs — autoFollowSince", () => {
  it("stamps the opt-in moment when a user turns auto-follow on", async () => {
    const { prisma } = fakePrisma(
      defaultRow("dave@example.com", { autoFollowSessions: false }),
    );
    const service = new SessionFollowService(prisma, FixedClock(NOW));

    const prefs = await service.updatePrefs("dave@example.com", {
      autoFollowSessions: true,
    });

    expect(prefs.autoFollowSessions).toBe(true);
    expect(prefs.autoFollowSince).toEqual(NOW);
  });

  it("stamps on first explicit opt-in even when the row already defaulted to on", async () => {
    // A never-touched row is `autoFollowSessions: true, autoFollowSince: null`
    // — the "always on" cohort. Ticking the box explicitly gives the sweeper a
    // boundary so the pre-existing backlog isn't back-followed.
    const { prisma } = fakePrisma(defaultRow("dave@example.com"));
    const service = new SessionFollowService(prisma, FixedClock(NOW));

    const prefs = await service.updatePrefs("dave@example.com", {
      autoFollowSessions: true,
    });

    expect(prefs.autoFollowSince).toEqual(NOW);
  });

  it("does not move an existing boundary when re-saving with auto-follow already on", async () => {
    const earlier = new Date("2026-01-01T00:00:00.000Z");
    const { prisma } = fakePrisma(
      defaultRow("dave@example.com", { autoFollowSince: earlier }),
    );
    const service = new SessionFollowService(prisma, FixedClock(NOW));

    const prefs = await service.updatePrefs("dave@example.com", {
      autoFollowSessions: true,
      reminderHourLocal: 14,
    });

    expect(prefs.autoFollowSince).toEqual(earlier);
    expect(prefs.reminderHourLocal).toBe(14);
  });

  it("leaves autoFollowSince untouched when turning auto-follow off", async () => {
    const earlier = new Date("2026-01-01T00:00:00.000Z");
    const { prisma } = fakePrisma(
      defaultRow("dave@example.com", { autoFollowSince: earlier }),
    );
    const service = new SessionFollowService(prisma, FixedClock(NOW));

    const prefs = await service.updatePrefs("dave@example.com", {
      autoFollowSessions: false,
    });

    expect(prefs.autoFollowSessions).toBe(false);
    expect(prefs.autoFollowSince).toEqual(earlier);
  });

  it("does not stamp when only reminderHourLocal changes", async () => {
    const { prisma } = fakePrisma(defaultRow("dave@example.com"));
    const service = new SessionFollowService(prisma, FixedClock(NOW));

    const prefs = await service.updatePrefs("dave@example.com", {
      reminderHourLocal: 7,
    });

    expect(prefs.autoFollowSince).toBeNull();
    expect(prefs.reminderHourLocal).toBe(7);
  });
});
