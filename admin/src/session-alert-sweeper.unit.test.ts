/**
 * admin/src/session-alert-sweeper.unit.test.ts
 * Unit tests for SessionAlertSweeper orchestration (SESH-7.4).
 *
 * Everything the sweeper touches is injected: an in-memory Prisma double, a
 * recording pushService double, plain membership/agent doubles, a plain
 * async fetchSessions function, and a FixedClock. No mock.module(), no
 * global.fetch override, no real Prisma — per the repo's hard test-isolation
 * rule (CLAUDE.md).
 */

import { describe, expect, it } from "bun:test";
import { FixedClock } from "./clock.ts";
import type { SessionNotificationKind } from "./push-service.ts";
import {
  type SessionAlertPrismaLike,
  type SessionAlertStateRow,
  SessionAlertSweeper,
  type SessionForAlert,
  localDateKey,
  localHour,
  resolveWaitingAlertKind,
} from "./session-alert-sweeper.ts";
import type {
  SessionFollowRow,
  UserNotificationPrefsRow,
} from "./session-follow-service.ts";

const TZ = "America/Los_Angeles";

// ─── Doubles ────────────────────────────────────────────────────────────────

interface SeedRows {
  follows?: Array<
    Partial<SessionFollowRow> & { userEmail: string; sessionSlug: string }
  >;
  alertStates?: Array<{
    userEmail: string;
    sessionSlug: string;
    lastAlertedAt: Date | null;
  }>;
  prefs?: Array<Partial<UserNotificationPrefsRow> & { userEmail: string }>;
}

interface FakeStore {
  follows: SessionFollowRow[];
  alertStates: SessionAlertStateRow[];
  prefs: UserNotificationPrefsRow[];
}

const EPOCH = new Date("2020-01-01T00:00:00.000Z");

function fakePrisma(seed: SeedRows = {}): {
  prisma: SessionAlertPrismaLike;
  store: FakeStore;
} {
  let nextId = 1;
  const store: FakeStore = {
    follows: (seed.follows ?? []).map((f) => ({
      id: `flw_${nextId++}`,
      muted: false,
      createdAt: EPOCH,
      updatedAt: EPOCH,
      ...f,
    })),
    alertStates: (seed.alertStates ?? []).map((s) => ({
      id: `als_${nextId++}`,
      createdAt: EPOCH,
      updatedAt: EPOCH,
      ...s,
    })),
    prefs: (seed.prefs ?? []).map((p) => ({
      autoFollowSessions: true,
      reminderHourLocal: 9,
      autoFollowSince: null,
      createdAt: EPOCH,
      updatedAt: EPOCH,
      ...p,
    })),
  };

  const prisma: SessionAlertPrismaLike = {
    sessionFollow: {
      findMany: async ({ where }) =>
        store.follows.filter((f) => f.sessionSlug === where.sessionSlug),
      upsert: async ({ where, create }) => {
        const key = where.userEmail_sessionSlug;
        const existing = store.follows.find(
          (f) =>
            f.userEmail === key.userEmail && f.sessionSlug === key.sessionSlug,
        );
        if (existing) return existing;
        const row: SessionFollowRow = {
          id: `flw_${nextId++}`,
          userEmail: create.userEmail,
          sessionSlug: create.sessionSlug,
          muted: false,
          createdAt: EPOCH,
          updatedAt: EPOCH,
        };
        store.follows.push(row);
        return row;
      },
      deleteMany: async ({ where }) => {
        const before = store.follows.length;
        store.follows = store.follows.filter(
          (f) =>
            !(
              f.userEmail === where.userEmail &&
              f.sessionSlug === where.sessionSlug
            ),
        );
        return { count: before - store.follows.length };
      },
    },
    sessionAlertState: {
      findMany: async ({ where }) =>
        store.alertStates.filter((s) => s.sessionSlug === where.sessionSlug),
      upsert: async ({ where, create, update }) => {
        const key = where.userEmail_sessionSlug;
        const existing = store.alertStates.find(
          (s) =>
            s.userEmail === key.userEmail && s.sessionSlug === key.sessionSlug,
        );
        if (existing) {
          existing.lastAlertedAt = update.lastAlertedAt;
          return existing;
        }
        const row: SessionAlertStateRow = {
          id: `als_${nextId++}`,
          userEmail: create.userEmail,
          sessionSlug: create.sessionSlug,
          lastAlertedAt: create.lastAlertedAt,
          createdAt: EPOCH,
          updatedAt: EPOCH,
        };
        store.alertStates.push(row);
        return row;
      },
      deleteMany: async ({ where }) => {
        const before = store.alertStates.length;
        store.alertStates = store.alertStates.filter(
          (s) =>
            !(
              s.userEmail === where.userEmail &&
              s.sessionSlug === where.sessionSlug
            ),
        );
        return { count: before - store.alertStates.length };
      },
    },
    userNotificationPrefs: {
      findMany: async () => store.prefs,
    },
  };

  return { prisma, store };
}

interface SentPush {
  slug: string;
  emails: string[];
  kind: SessionNotificationKind;
}

function fakePushService() {
  const sent: SentPush[] = [];
  return {
    sent,
    pushService: {
      notifySession: async (
        session: { slug: string; emails: string[] },
        _level: "generic" | "title" | "preview",
        kind: SessionNotificationKind,
      ) => {
        sent.push({ slug: session.slug, emails: session.emails, kind });
        return { delivered: session.emails.length, pruned: 0 };
      },
    },
  };
}

/** Membership + agent doubles: `email -> agentIds`, `agentId -> repos`. */
function fakeScopeServices(
  membershipsByEmail: Record<string, string[]>,
  reposByAgentId: Record<string, string[]> = {},
) {
  return {
    agentMemberService: {
      listByEmail: async (email: string) =>
        (membershipsByEmail[email] ?? []).map((agentId, i) => ({
          id: `mem_${i}`,
          agentId,
          email,
          createdAt: EPOCH,
        })),
    },
    agentService: {
      listByIds: async (ids: string[]) =>
        ids.map((id) => ({
          id,
          repos: reposByAgentId[id] ?? [],
        })),
    },
  };
}

const WAITING_SESSION: SessionForAlert = {
  slug: "sess-waiting",
  title: "Waiting session",
  agentIds: ["agt_1"],
  repos: ["org/repo"],
};

const CLOSED_SESSION: SessionForAlert = {
  slug: "sess-closed",
  title: "Closed session",
  agentIds: ["agt_1"],
  repos: ["org/repo"],
};

function fetchSessionsDouble(sessions: {
  waiting?: SessionForAlert[];
  closed?: SessionForAlert[];
}) {
  return async (state: "waiting" | "closed") =>
    state === "waiting" ? (sessions.waiting ?? []) : (sessions.closed ?? []);
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe("localDateKey / localHour", () => {
  it("renders the local calendar date in the given timezone", () => {
    // 2026-03-02T04:00:00Z is still 2026-03-01 20:00 in Los Angeles.
    expect(localDateKey(new Date("2026-03-02T04:00:00Z"), TZ)).toBe(
      "2026-03-01",
    );
    expect(localDateKey(new Date("2026-03-02T04:00:00Z"), "UTC")).toBe(
      "2026-03-02",
    );
  });

  it("renders the local hour in 0–23 form, including midnight", () => {
    expect(localHour(new Date("2026-03-02T04:00:00Z"), TZ)).toBe(20);
    expect(localHour(new Date("2026-03-02T08:00:00Z"), TZ)).toBe(0);
    expect(localHour(new Date("2026-03-02T17:30:00Z"), TZ)).toBe(9);
  });
});

describe("resolveWaitingAlertKind", () => {
  it("returns 'immediate' when the user has never been alerted", () => {
    expect(
      resolveWaitingAlertKind(null, new Date("2026-03-02T17:00:00Z"), 9, TZ),
    ).toBe("immediate");
  });

  it("returns null on the same local day as the last alert", () => {
    expect(
      resolveWaitingAlertKind(
        new Date("2026-03-02T17:00:00Z"),
        new Date("2026-03-02T23:00:00Z"),
        9,
        TZ,
      ),
    ).toBeNull();
  });

  it("returns 'reminder' on a later local day at/after reminderHourLocal", () => {
    expect(
      resolveWaitingAlertKind(
        new Date("2026-03-02T17:00:00Z"),
        new Date("2026-03-03T17:00:00Z"), // 09:00 PT
        9,
        TZ,
      ),
    ).toBe("reminder");
  });

  it("returns null on a later local day before reminderHourLocal", () => {
    expect(
      resolveWaitingAlertKind(
        new Date("2026-03-02T17:00:00Z"),
        new Date("2026-03-03T15:00:00Z"), // 07:00 PT
        9,
        TZ,
      ),
    ).toBeNull();
  });
});

// ─── AC1: immediate alert, exactly once ─────────────────────────────────────

describe("SessionAlertSweeper.tick — waiting sessions (AC1)", () => {
  it("sends exactly one immediate push per subscribed follower, and none on the next tick", async () => {
    const { prisma, store } = fakePrisma({
      follows: [
        { userEmail: "dave@example.com", sessionSlug: "sess-waiting" },
        { userEmail: "dan@example.com", sessionSlug: "sess-waiting" },
      ],
      prefs: [
        { userEmail: "dave@example.com", autoFollowSessions: false },
        { userEmail: "dan@example.com", autoFollowSessions: false },
      ],
    });
    const { pushService, sent } = fakePushService();
    const scope = fakeScopeServices({
      "dave@example.com": ["agt_1"],
      "dan@example.com": ["agt_1"],
    });

    const sweeper = new SessionAlertSweeper({
      prisma,
      pushService,
      ...scope,
      fetchSessions: fetchSessionsDouble({ waiting: [WAITING_SESSION] }),
      clock: FixedClock(new Date("2026-03-02T17:00:00Z")), // 09:00 PT
      timezone: TZ,
    });

    const first = await sweeper.tick();
    expect(first).toEqual({
      immediate: 2,
      reminders: 0,
      completions: 0,
      pruned: 0,
    });
    expect(sent).toHaveLength(2);
    expect(sent.every((s) => s.kind === "immediate")).toBe(true);
    expect(sent.flatMap((s) => s.emails).sort()).toEqual([
      "dan@example.com",
      "dave@example.com",
    ]);
    expect(store.alertStates).toHaveLength(2);

    const second = await sweeper.tick();
    expect(second).toEqual({
      immediate: 0,
      reminders: 0,
      completions: 0,
      pruned: 0,
    });
    expect(sent).toHaveLength(2);
  });

  it("materializes an auto-follow row for a visible autoFollowSessions user and alerts them", async () => {
    const { prisma, store } = fakePrisma({
      prefs: [{ userEmail: "dave@example.com", autoFollowSessions: true }],
    });
    const { pushService, sent } = fakePushService();
    const scope = fakeScopeServices({ "dave@example.com": ["agt_1"] });

    const sweeper = new SessionAlertSweeper({
      prisma,
      pushService,
      ...scope,
      fetchSessions: fetchSessionsDouble({ waiting: [WAITING_SESSION] }),
      clock: FixedClock(new Date("2026-03-02T17:00:00Z")),
      timezone: TZ,
    });

    const result = await sweeper.tick();
    expect(result.immediate).toBe(1);
    expect(store.follows).toHaveLength(1);
    expect(store.follows[0]?.userEmail).toBe("dave@example.com");
    expect(sent).toHaveLength(1);
  });

  it("does not auto-follow (or alert) a user who cannot see the session", async () => {
    const { prisma, store } = fakePrisma({
      prefs: [{ userEmail: "outsider@example.com", autoFollowSessions: true }],
    });
    const { pushService, sent } = fakePushService();
    const scope = fakeScopeServices({ "outsider@example.com": [] });

    const sweeper = new SessionAlertSweeper({
      prisma,
      pushService,
      ...scope,
      fetchSessions: fetchSessionsDouble({ waiting: [WAITING_SESSION] }),
      clock: FixedClock(new Date("2026-03-02T17:00:00Z")),
      timezone: TZ,
    });

    const result = await sweeper.tick();
    expect(result.immediate).toBe(0);
    expect(store.follows).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("skips muted followers entirely (no push, no alert state)", async () => {
    const { prisma, store } = fakePrisma({
      follows: [
        {
          userEmail: "dave@example.com",
          sessionSlug: "sess-waiting",
          muted: true,
        },
      ],
    });
    const { pushService, sent } = fakePushService();
    const scope = fakeScopeServices({ "dave@example.com": ["agt_1"] });

    const sweeper = new SessionAlertSweeper({
      prisma,
      pushService,
      ...scope,
      fetchSessions: fetchSessionsDouble({ waiting: [WAITING_SESSION] }),
      clock: FixedClock(new Date("2026-03-02T17:00:00Z")),
      timezone: TZ,
    });

    const result = await sweeper.tick();
    expect(result.immediate).toBe(0);
    expect(sent).toHaveLength(0);
    expect(store.alertStates).toHaveLength(0);
  });
});

// ─── AC2: next-day reminder, exactly once per day ───────────────────────────

describe("SessionAlertSweeper.tick — reminders (AC2)", () => {
  it("sends one reminder the next local day past reminderHourLocal and none on a second same-day tick", async () => {
    const { prisma } = fakePrisma({
      follows: [{ userEmail: "dave@example.com", sessionSlug: "sess-waiting" }],
      alertStates: [
        {
          userEmail: "dave@example.com",
          sessionSlug: "sess-waiting",
          // 2026-03-02 09:00 PT
          lastAlertedAt: new Date("2026-03-02T17:00:00Z"),
        },
      ],
      prefs: [
        {
          userEmail: "dave@example.com",
          autoFollowSessions: false,
          reminderHourLocal: 9,
        },
      ],
    });
    const { pushService, sent } = fakePushService();
    const scope = fakeScopeServices({ "dave@example.com": ["agt_1"] });

    const deps = {
      prisma,
      pushService,
      ...scope,
      fetchSessions: fetchSessionsDouble({ waiting: [WAITING_SESSION] }),
      timezone: TZ,
    };

    // Same local day, later hour → nothing.
    const sameDay = await new SessionAlertSweeper({
      ...deps,
      clock: FixedClock(new Date("2026-03-02T23:00:00Z")), // 15:00 PT same day
    }).tick();
    expect(sameDay.reminders).toBe(0);
    expect(sent).toHaveLength(0);

    // Next local day but before 09:00 PT → still nothing.
    const earlyNextDay = await new SessionAlertSweeper({
      ...deps,
      clock: FixedClock(new Date("2026-03-03T15:00:00Z")), // 07:00 PT
    }).tick();
    expect(earlyNextDay.reminders).toBe(0);
    expect(sent).toHaveLength(0);

    // Next local day at 09:00 PT → exactly one reminder.
    const reminderTick = await new SessionAlertSweeper({
      ...deps,
      clock: FixedClock(new Date("2026-03-03T17:00:00Z")), // 09:00 PT
    }).tick();
    expect(reminderTick).toEqual({
      immediate: 0,
      reminders: 1,
      completions: 0,
      pruned: 0,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe("reminder");

    // Second tick the same (new) day → nothing further.
    const secondSameDay = await new SessionAlertSweeper({
      ...deps,
      clock: FixedClock(new Date("2026-03-03T21:00:00Z")), // 13:00 PT
    }).tick();
    expect(secondSameDay.reminders).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("honors a per-user reminderHourLocal other than the default", async () => {
    const { prisma } = fakePrisma({
      follows: [{ userEmail: "dan@example.com", sessionSlug: "sess-waiting" }],
      alertStates: [
        {
          userEmail: "dan@example.com",
          sessionSlug: "sess-waiting",
          lastAlertedAt: new Date("2026-03-02T17:00:00Z"),
        },
      ],
      prefs: [
        {
          userEmail: "dan@example.com",
          autoFollowSessions: false,
          reminderHourLocal: 18,
        },
      ],
    });
    const { pushService, sent } = fakePushService();
    const scope = fakeScopeServices({ "dan@example.com": ["agt_1"] });

    const deps = {
      prisma,
      pushService,
      ...scope,
      fetchSessions: fetchSessionsDouble({ waiting: [WAITING_SESSION] }),
      timezone: TZ,
    };

    // 09:00 PT the next day is before their 18:00 preference.
    const early = await new SessionAlertSweeper({
      ...deps,
      clock: FixedClock(new Date("2026-03-03T17:00:00Z")),
    }).tick();
    expect(early.reminders).toBe(0);
    expect(sent).toHaveLength(0);

    // 18:00 PT the next day clears their threshold.
    const late = await new SessionAlertSweeper({
      ...deps,
      clock: FixedClock(new Date("2026-03-04T02:00:00Z")), // 18:00 PT on 03-03
    }).tick();
    expect(late.reminders).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("defaults reminderHourLocal to 9 when the user has no prefs row", async () => {
    const { prisma } = fakePrisma({
      follows: [
        { userEmail: "nobody@example.com", sessionSlug: "sess-waiting" },
      ],
      alertStates: [
        {
          userEmail: "nobody@example.com",
          sessionSlug: "sess-waiting",
          lastAlertedAt: new Date("2026-03-02T17:00:00Z"),
        },
      ],
    });
    const { pushService, sent } = fakePushService();
    const scope = fakeScopeServices({ "nobody@example.com": ["agt_1"] });

    const result = await new SessionAlertSweeper({
      prisma,
      pushService,
      ...scope,
      fetchSessions: fetchSessionsDouble({ waiting: [WAITING_SESSION] }),
      clock: FixedClock(new Date("2026-03-03T17:00:00Z")), // 09:00 PT next day
      timezone: TZ,
    }).tick();

    expect(result.reminders).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

// ─── AC3: completion notices + fetch failure ────────────────────────────────

describe("SessionAlertSweeper.tick — closed sessions (AC3)", () => {
  it("sends exactly one completed push per follower, then cleans up so later ticks send nothing", async () => {
    const { prisma, store } = fakePrisma({
      follows: [{ userEmail: "dave@example.com", sessionSlug: "sess-closed" }],
      alertStates: [
        {
          userEmail: "dave@example.com",
          sessionSlug: "sess-closed",
          lastAlertedAt: new Date("2026-03-02T17:00:00Z"),
        },
      ],
    });
    const { pushService, sent } = fakePushService();
    const scope = fakeScopeServices({ "dave@example.com": ["agt_1"] });

    const sweeper = new SessionAlertSweeper({
      prisma,
      pushService,
      ...scope,
      fetchSessions: fetchSessionsDouble({ closed: [CLOSED_SESSION] }),
      clock: FixedClock(new Date("2026-03-02T20:00:00Z")),
      timezone: TZ,
    });

    const first = await sweeper.tick();
    expect(first).toEqual({
      immediate: 0,
      reminders: 0,
      completions: 1,
      pruned: 0,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe("completed");
    expect(store.follows).toHaveLength(0);
    expect(store.alertStates).toHaveLength(0);

    const second = await sweeper.tick();
    expect(second.completions).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("returns all-zero counters and sends nothing when the sessions fetch rejects", async () => {
    const { prisma } = fakePrisma({
      follows: [{ userEmail: "dave@example.com", sessionSlug: "sess-waiting" }],
    });
    const { pushService, sent } = fakePushService();
    const scope = fakeScopeServices({ "dave@example.com": ["agt_1"] });

    const result = await new SessionAlertSweeper({
      prisma,
      pushService,
      ...scope,
      fetchSessions: () => Promise.reject(new Error("boom")),
      clock: FixedClock(new Date("2026-03-02T17:00:00Z")),
      timezone: TZ,
    }).tick();

    expect(result).toEqual({
      immediate: 0,
      reminders: 0,
      completions: 0,
      pruned: 0,
    });
    expect(sent).toHaveLength(0);
  });
});

// ─── AC4: visibility loss prunes state ──────────────────────────────────────

describe("SessionAlertSweeper.tick — visibility loss (AC4)", () => {
  it("sends no push and prunes the alert-state row of a follower who lost visibility", async () => {
    const { prisma, store } = fakePrisma({
      follows: [
        { userEmail: "dave@example.com", sessionSlug: "sess-waiting" },
        { userEmail: "gone@example.com", sessionSlug: "sess-waiting" },
      ],
      alertStates: [
        {
          userEmail: "gone@example.com",
          sessionSlug: "sess-waiting",
          lastAlertedAt: new Date("2026-03-01T17:00:00Z"),
        },
      ],
    });
    const { pushService, sent } = fakePushService();
    // dave keeps membership on agt_1; gone@ has no memberships at all.
    const scope = fakeScopeServices({
      "dave@example.com": ["agt_1"],
      "gone@example.com": [],
    });

    const result = await new SessionAlertSweeper({
      prisma,
      pushService,
      ...scope,
      fetchSessions: fetchSessionsDouble({ waiting: [WAITING_SESSION] }),
      clock: FixedClock(new Date("2026-03-02T17:00:00Z")),
      timezone: TZ,
    }).tick();

    expect(result.pruned).toBe(1);
    expect(result.immediate).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.emails).toEqual(["dave@example.com"]);
    expect(
      store.alertStates.some((s) => s.userEmail === "gone@example.com"),
    ).toBe(false);
  });

  it("prunes a closed-session follower who lost visibility instead of notifying them", async () => {
    const { prisma, store } = fakePrisma({
      follows: [{ userEmail: "gone@example.com", sessionSlug: "sess-closed" }],
      alertStates: [
        {
          userEmail: "gone@example.com",
          sessionSlug: "sess-closed",
          lastAlertedAt: new Date("2026-03-01T17:00:00Z"),
        },
      ],
    });
    const { pushService, sent } = fakePushService();
    const scope = fakeScopeServices({ "gone@example.com": [] });

    const result = await new SessionAlertSweeper({
      prisma,
      pushService,
      ...scope,
      fetchSessions: fetchSessionsDouble({ closed: [CLOSED_SESSION] }),
      clock: FixedClock(new Date("2026-03-02T17:00:00Z")),
      timezone: TZ,
    }).tick();

    expect(result.completions).toBe(0);
    expect(result.pruned).toBe(1);
    expect(sent).toHaveLength(0);
    expect(store.alertStates).toHaveLength(0);
  });

  it("matches visibility on repo overlap when the agent id does not match", async () => {
    const { prisma } = fakePrisma({
      follows: [{ userEmail: "dave@example.com", sessionSlug: "sess-waiting" }],
    });
    const { pushService, sent } = fakePushService();
    const scope = fakeScopeServices(
      { "dave@example.com": ["agt_other"] },
      { agt_other: ["org/repo"] },
    );

    const result = await new SessionAlertSweeper({
      prisma,
      pushService,
      ...scope,
      fetchSessions: fetchSessionsDouble({ waiting: [WAITING_SESSION] }),
      clock: FixedClock(new Date("2026-03-02T17:00:00Z")),
      timezone: TZ,
    }).tick();

    expect(result.immediate).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

// ─── Resilience: one bad row never aborts the sweep ─────────────────────────

describe("SessionAlertSweeper.tick — per-row resilience", () => {
  it("keeps sweeping after a per-follower failure", async () => {
    const { prisma } = fakePrisma({
      follows: [
        { userEmail: "boom@example.com", sessionSlug: "sess-waiting" },
        { userEmail: "dave@example.com", sessionSlug: "sess-waiting" },
      ],
    });
    const { pushService, sent } = fakePushService();
    const scope = fakeScopeServices({
      "boom@example.com": ["agt_1"],
      "dave@example.com": ["agt_1"],
    });
    const failingMembers = {
      listByEmail: async (email: string) => {
        if (email === "boom@example.com") throw new Error("membership lookup");
        return scope.agentMemberService.listByEmail(email);
      },
    };

    const result = await new SessionAlertSweeper({
      prisma,
      pushService,
      agentMemberService: failingMembers,
      agentService: scope.agentService,
      fetchSessions: fetchSessionsDouble({ waiting: [WAITING_SESSION] }),
      clock: FixedClock(new Date("2026-03-02T17:00:00Z")),
      timezone: TZ,
    }).tick();

    expect(result.immediate).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.emails).toEqual(["dave@example.com"]);
  });

  it("keeps sweeping later sessions after one session's follow lookup fails", async () => {
    const { prisma } = fakePrisma({
      follows: [{ userEmail: "dave@example.com", sessionSlug: "sess-waiting" }],
    });
    const brokenPrisma: SessionAlertPrismaLike = {
      ...prisma,
      sessionFollow: {
        ...prisma.sessionFollow,
        findMany: async (args) => {
          if (args.where.sessionSlug === "sess-broken") {
            throw new Error("db down");
          }
          return prisma.sessionFollow.findMany(args);
        },
      },
    };
    const { pushService, sent } = fakePushService();
    const scope = fakeScopeServices({ "dave@example.com": ["agt_1"] });

    const result = await new SessionAlertSweeper({
      prisma: brokenPrisma,
      pushService,
      ...scope,
      fetchSessions: fetchSessionsDouble({
        waiting: [
          { slug: "sess-broken", agentIds: ["agt_1"], repos: [] },
          WAITING_SESSION,
        ],
      }),
      clock: FixedClock(new Date("2026-03-02T17:00:00Z")),
      timezone: TZ,
    }).tick();

    expect(result.immediate).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("resolves each follower's scope at most once per tick", async () => {
    const { prisma } = fakePrisma({
      follows: [
        { userEmail: "dave@example.com", sessionSlug: "sess-waiting" },
        { userEmail: "dave@example.com", sessionSlug: "sess-waiting-2" },
      ],
    });
    const { pushService } = fakePushService();
    let calls = 0;
    const countingMembers = {
      listByEmail: async (email: string) => {
        calls++;
        return [{ id: "mem_1", agentId: "agt_1", email, createdAt: EPOCH }];
      },
    };
    const scope = fakeScopeServices({ "dave@example.com": ["agt_1"] });

    await new SessionAlertSweeper({
      prisma,
      pushService,
      agentMemberService: countingMembers,
      agentService: scope.agentService,
      fetchSessions: fetchSessionsDouble({
        waiting: [
          WAITING_SESSION,
          { slug: "sess-waiting-2", agentIds: ["agt_1"], repos: [] },
        ],
      }),
      clock: FixedClock(new Date("2026-03-02T17:00:00Z")),
      timezone: TZ,
    }).tick();

    expect(calls).toBe(1);
  });
});
