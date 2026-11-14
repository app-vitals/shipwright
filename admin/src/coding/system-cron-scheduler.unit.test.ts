/**
 * admin/src/coding/system-cron-scheduler.unit.test.ts
 * SystemCronScheduler.tick() (SCR-1.3) against an in-memory task-store
 * double, a scripted lookup-App lister and an injected clock:
 *   - the seed rule: a never-fired definition's baseline is its enable time
 *   - catch-up: every missed slot fires once, oldest first
 *   - the lookup App is consulted once per tick, only when a slot is due;
 *     unconfigured → the tick is skipped and nothing is recorded
 *   - archived repos are dropped; lister errors propagate and record nothing
 *   - a failing fire stops that definition's later slots (no out-of-order
 *     claims) without affecting other definitions
 */

import { describe, expect, it } from "bun:test";
import {
  createHttpSystemCronStore,
  type LookupRepositoryLister,
  type SystemCronDefinitionView,
  SystemCronScheduler,
  type SystemCronStore,
} from "./system-cron-scheduler.ts";

interface FireCall {
  id: string;
  scheduledFor: string;
  repos: string[];
}

/** In-memory task-store: claims slots exactly once, like the real /fire. */
class FakeStore implements SystemCronStore {
  defs: SystemCronDefinitionView[] = [];
  claimed = new Map<string, Set<string>>();
  fires: FireCall[] = [];
  failFire?: (call: FireCall) => boolean;
  failLastTrigger = new Set<string>();

  async listEnabled() {
    return this.defs.filter((d) => d.enabled);
  }

  async lastTrigger(id: string) {
    if (this.failLastTrigger.has(id)) throw new Error("last-trigger 500");
    const slots = [...(this.claimed.get(id) ?? [])].sort();
    return slots.at(-1) ?? null;
  }

  async fire(id: string, scheduledFor: string, repos: string[]) {
    const call = { id, scheduledFor, repos };
    this.fires.push(call);
    if (this.failFire?.(call)) throw new Error("fire 500");
    const set = this.claimed.get(id) ?? new Set<string>();
    this.claimed.set(id, set);
    if (set.has(scheduledFor)) return { claimed: false, taskIds: [] };
    set.add(scheduledFor);
    return { claimed: true, taskIds: repos.map((r) => `${id}:${r}`) };
  }
}

function lister(
  result:
    | { configured: boolean; repos: { fullName: string; archived: boolean }[] }
    | Error,
): LookupRepositoryLister & { calls: number } {
  const l = {
    calls: 0,
    async listRepositories() {
      l.calls++;
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return l;
}

const REPOS = {
  configured: true,
  repos: [
    { fullName: "acme/widgets", archived: false },
    { fullName: "acme/old", archived: true },
    { fullName: "acme/gadgets", archived: false },
  ],
};

function def(
  over: Partial<SystemCronDefinitionView> = {},
): SystemCronDefinitionView {
  return {
    id: "docs-freshness",
    schedule: "0 7 * * *",
    timezone: "UTC",
    enabled: true,
    enabledAt: "2026-11-10T12:00:00.000Z",
    updatedAt: "2026-11-10T12:00:00.000Z",
    ...over,
  };
}

function setup(now: string, lookup = lister(REPOS)) {
  const store = new FakeStore();
  const clock = { current: new Date(now) };
  const logs: string[] = [];
  const errors: string[] = [];
  const scheduler = new SystemCronScheduler({
    store,
    lookup,
    clock: { now: () => clock.current },
    log: (m) => logs.push(m),
    error: (m) => errors.push(String(m)),
  });
  return { store, clock, scheduler, lookup, logs, errors };
}

describe("SystemCronScheduler — seed rule (never-fired definition)", () => {
  it("baseline is the enable time: no backlog, first fire is the first slot after enabling", async () => {
    // Created long ago, enabled at 2026-11-14 07:30 — the 07:00 slot that
    // day (and every earlier one) is before enabling and must never fire.
    const { store, clock, scheduler, lookup } = setup("2026-11-14T07:31:00Z");
    store.defs = [
      def({
        enabledAt: "2026-11-14T07:30:00.000Z",
        updatedAt: "2026-11-14T07:30:00.000Z",
      }),
    ];

    expect((await scheduler.tick()).status).toBe("idle");
    expect(store.fires).toEqual([]);
    expect(lookup.calls).toBe(0);

    clock.current = new Date("2026-11-15T07:00:20Z");
    await scheduler.tick();
    expect(store.fires.map((f) => f.scheduledFor)).toEqual([
      "2026-11-15T07:00:00.000Z",
    ]);
  });

  it("a slot exactly at the enable instant does not fire", async () => {
    const { store, scheduler } = setup("2026-11-14T07:05:00Z");
    store.defs = [def({ enabledAt: "2026-11-14T07:00:00.000Z" })];
    await scheduler.tick();
    expect(store.fires).toEqual([]);
  });

  it("falls back to updatedAt when an enabled definition has no enabledAt", async () => {
    const { store, scheduler } = setup("2026-11-14T07:05:00Z");
    store.defs = [
      def({ enabledAt: null, updatedAt: "2026-11-13T08:00:00.000Z" }),
    ];
    await scheduler.tick();
    expect(store.fires.map((f) => f.scheduledFor)).toEqual([
      "2026-11-14T07:00:00.000Z",
    ]);
  });
});

describe("SystemCronScheduler — catch-up", () => {
  it("fires every missed slot since the last claimed trigger, oldest first, each once", async () => {
    const { store, scheduler, lookup } = setup("2026-11-14T07:00:05Z");
    store.defs = [def()];
    store.claimed.set("docs-freshness", new Set(["2026-11-11T07:00:00.000Z"]));

    const result = await scheduler.tick();
    expect(result.status).toBe("fired");
    expect(store.fires.map((f) => f.scheduledFor)).toEqual([
      "2026-11-12T07:00:00.000Z",
      "2026-11-13T07:00:00.000Z",
      "2026-11-14T07:00:00.000Z",
    ]);
    expect(store.fires[0].repos).toEqual(["acme/widgets", "acme/gadgets"]);
    expect(lookup.calls).toBe(1);

    // Same minute, next tick: nothing new is due, the lister isn't called.
    await scheduler.tick();
    expect(store.fires).toHaveLength(3);
    expect(lookup.calls).toBe(1);
  });

  it("a re-enabled definition doesn't replay its disabled period", async () => {
    const { store, scheduler } = setup("2026-11-20T07:30:00Z");
    store.defs = [def({ enabledAt: "2026-11-19T12:00:00.000Z" })];
    store.claimed.set("docs-freshness", new Set(["2026-11-11T07:00:00.000Z"]));
    await scheduler.tick();
    expect(store.fires.map((f) => f.scheduledFor)).toEqual([
      "2026-11-20T07:00:00.000Z",
    ]);
  });

  it("two schedulers on one store claim each slot once (the store dedupes)", async () => {
    const shared = setup("2026-11-14T07:00:05Z");
    shared.store.defs = [def({ enabledAt: "2026-11-12T08:00:00.000Z" })];
    const other = new SystemCronScheduler({
      store: shared.store,
      lookup: lister(REPOS),
      clock: { now: () => shared.clock.current },
      log: () => {},
      error: () => {},
    });
    const [a, b] = await Promise.all([shared.scheduler.tick(), other.tick()]);
    const claimed = [...a.fired, ...b.fired].filter((f) => f.claimed);
    expect(claimed.map((f) => f.scheduledFor).sort()).toEqual([
      "2026-11-13T07:00:00.000Z",
      "2026-11-14T07:00:00.000Z",
    ]);
  });

  it("fetches repos once per tick across every due definition", async () => {
    const { store, scheduler, lookup } = setup("2026-11-14T07:00:05Z");
    store.defs = [
      def({ enabledAt: "2026-11-13T08:00:00.000Z" }),
      def({
        id: "test-readiness",
        schedule: "0 6 * * *",
        enabledAt: "2026-11-13T08:00:00.000Z",
      }),
    ];
    await scheduler.tick();
    expect(lookup.calls).toBe(1);
    expect(store.fires.map((f) => `${f.id}@${f.scheduledFor}`)).toEqual([
      "docs-freshness@2026-11-14T07:00:00.000Z",
      "test-readiness@2026-11-14T06:00:00.000Z",
    ]);
  });
});

describe("SystemCronScheduler — lookup App and errors", () => {
  it("skips the tick and records nothing when the lookup App is not configured", async () => {
    const { store, scheduler, logs } = setup(
      "2026-11-14T07:00:05Z",
      lister({ configured: false, repos: [] }),
    );
    store.defs = [def()];
    const result = await scheduler.tick();
    expect(result.status).toBe("skipped-unconfigured");
    expect(store.fires).toEqual([]);
    expect(logs.some((l) => l.includes("lookup App not configured"))).toBe(
      true,
    );
  });

  it("propagates a lister failure without firing (nothing recorded)", async () => {
    const { store, scheduler } = setup(
      "2026-11-14T07:00:05Z",
      lister(new Error("GitHub 502")),
    );
    store.defs = [def()];
    await expect(scheduler.tick()).rejects.toThrow("GitHub 502");
    expect(store.fires).toEqual([]);
  });

  it("skips (records nothing) when every visible repo is archived", async () => {
    const { store, scheduler } = setup(
      "2026-11-14T07:00:05Z",
      lister({
        configured: true,
        repos: [{ fullName: "acme/old", archived: true }],
      }),
    );
    store.defs = [def()];
    expect((await scheduler.tick()).status).toBe("skipped-no-repos");
    expect(store.fires).toEqual([]);
  });

  it("a failed fire stops that definition's later slots but not other definitions", async () => {
    const { store, scheduler, errors } = setup("2026-11-14T07:00:05Z");
    store.defs = [
      def({ enabledAt: "2026-11-11T08:00:00.000Z" }),
      def({
        id: "test-readiness",
        schedule: "0 6 * * *",
        enabledAt: "2026-11-13T08:00:00.000Z",
      }),
    ];
    store.failFire = (c) =>
      c.id === "docs-freshness" && c.scheduledFor.startsWith("2026-11-13");

    const result = await scheduler.tick();
    expect(store.fires.map((f) => `${f.id}@${f.scheduledFor}`)).toEqual([
      "docs-freshness@2026-11-12T07:00:00.000Z",
      "docs-freshness@2026-11-13T07:00:00.000Z",
      "test-readiness@2026-11-14T06:00:00.000Z",
    ]);
    expect(result.errors.map((e) => e.cronId)).toEqual(["docs-freshness"]);
    expect(errors).toHaveLength(1);

    // The failed slot was not recorded, so the next tick retries it in order.
    store.failFire = undefined;
    await scheduler.tick();
    expect([...(store.claimed.get("docs-freshness") ?? [])].sort()).toEqual([
      "2026-11-12T07:00:00.000Z",
      "2026-11-13T07:00:00.000Z",
      "2026-11-14T07:00:00.000Z",
    ]);
  });

  it("skips a definition whose last-trigger read or schedule fails, and runs the rest", async () => {
    const { store, scheduler } = setup("2026-11-14T07:00:05Z");
    store.defs = [
      def({ id: "bad-schedule", schedule: "nope nope" }),
      def({ id: "bad-read" }),
      def({ id: "good", enabledAt: "2026-11-13T08:00:00.000Z" }),
    ];
    store.failLastTrigger.add("bad-read");
    const result = await scheduler.tick();
    expect(store.fires.map((f) => f.id)).toEqual(["good"]);
    expect(result.errors.map((e) => e.cronId).sort()).toEqual([
      "bad-read",
      "bad-schedule",
    ]);
  });

  it("does not overlap: a tick while one is in flight returns busy", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const store = new FakeStore();
    store.defs = [def()];
    const slowStore: SystemCronStore = {
      listEnabled: async () => {
        await gate;
        return store.listEnabled();
      },
      lastTrigger: (id) => store.lastTrigger(id),
      fire: (id, s, r) => store.fire(id, s, r),
    };
    const scheduler = new SystemCronScheduler({
      store: slowStore,
      lookup: lister(REPOS),
      clock: { now: () => new Date("2026-11-14T07:00:05Z") },
      log: () => {},
      error: () => {},
    });
    const first = scheduler.tick();
    expect((await scheduler.tick()).status).toBe("busy");
    release();
    expect((await first).status).toBe("fired");
  });
});

describe("createHttpSystemCronStore", () => {
  function recorder(responses: Response[]) {
    const calls: { url: string; init?: RequestInit }[] = [];
    return {
      calls,
      fetch: async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const next = responses.shift();
        if (!next) throw new Error("unexpected call");
        return next;
      },
    };
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  it("lists enabled definitions, reads last-trigger and fires with the admin token", async () => {
    const rec = recorder([
      json({ systemCrons: [def()] }),
      json({ scheduledFor: "2026-11-13T07:00:00.000Z" }),
      json({ claimed: true, taskIds: ["a"] }, 201),
      json({ claimed: false, taskIds: [] }, 200),
    ]);
    const store = createHttpSystemCronStore({
      url: "http://ts.test",
      adminToken: "tok",
      fetch: rec.fetch,
    });
    expect(await store.listEnabled()).toEqual([def()]);
    expect(await store.lastTrigger("docs-freshness")).toBe(
      "2026-11-13T07:00:00.000Z",
    );
    expect(
      await store.fire("docs-freshness", "2026-11-14T07:00:00.000Z", [
        "acme/widgets",
      ]),
    ).toEqual({ claimed: true, taskIds: ["a"] });
    expect(
      (await store.fire("docs-freshness", "2026-11-14T07:00:00.000Z", ["a/b"]))
        .claimed,
    ).toBe(false);

    expect(rec.calls.map((c) => c.url)).toEqual([
      "http://ts.test/system-crons?enabled=true",
      "http://ts.test/system-crons/docs-freshness/last-trigger",
      "http://ts.test/system-crons/docs-freshness/fire",
      "http://ts.test/system-crons/docs-freshness/fire",
    ]);
    const fireInit = rec.calls[2].init;
    expect(fireInit?.method).toBe("POST");
    expect(JSON.parse(String(fireInit?.body))).toEqual({
      scheduledFor: "2026-11-14T07:00:00.000Z",
      repos: ["acme/widgets"],
    });
    for (const c of rec.calls) {
      expect(new Headers(c.init?.headers).get("Authorization")).toBe(
        "Bearer tok",
      );
    }
  });

  it("throws on any non-2xx (a disabled definition's 409 included)", async () => {
    const rec = recorder([
      json({ error: "boom" }, 500),
      json({ error: "nf" }, 404),
      json({ error: "disabled" }, 409),
    ]);
    const store = createHttpSystemCronStore({
      url: "http://ts.test",
      adminToken: "tok",
      fetch: rec.fetch,
    });
    await expect(store.listEnabled()).rejects.toThrow("500");
    await expect(store.lastTrigger("x")).rejects.toThrow("404");
    await expect(
      store.fire("x", "2026-11-14T07:00:00Z", ["a/b"]),
    ).rejects.toThrow("409");
  });
});
