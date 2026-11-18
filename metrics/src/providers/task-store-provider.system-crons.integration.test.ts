/**
 * metrics/src/providers/task-store-provider.system-crons.integration.test.ts
 * Integration (SCM-8.3): TaskStoreProvider.systemCrons over the real
 * HttpTaskStoreClient against a fake task-store `fetch` that seeds tasks and
 * PRs and enforces token visibility like the live store: the account-wide
 * (admin) token sees everything, an agent token sees only
 * assignee=agent OR repo IN agent repos (task-service.ts), and /system-crons is
 * admin-only. Asserts the metrics service's own token yields the full counts
 * and that createdAt range + originRef filters reach the wire.
 */

import { describe, expect, test } from "bun:test";
import {
  type FetchLike,
  HttpTaskStoreClient,
  type PrRecord,
  type TaskRecord,
} from "../lib/task-store-client.ts";
import { FixedClock } from "../lib/test-helpers.ts";
import { TaskStoreProvider } from "./task-store-provider.ts";

const NOW = "2026-11-18T12:00:00.000Z";
const HOUR = 3_600_000;
const ago = (h: number) => new Date(Date.parse(NOW) - h * HOUR).toISOString();

const ADMIN = "admin-token";
const AGENT = "agent-token";
const AGENT_REPOS = ["o/mine"];

type Seed = TaskRecord & { assignee?: string | null };

const sc = (slot: string, repo: string, over: Partial<Seed> = {}): Seed => ({
  id: `SC-test-readiness-${slot}-${repo.replace("/", "-")}`,
  status: "pending",
  repo,
  pr: null,
  source: "system-cron",
  originKind: "cron",
  originRef: "test-readiness",
  createdAt: ago(5),
  ...over,
});

const TASKS: Seed[] = [
  // slot A: shipped, in flight, stuck(blocked)
  sc("20261118T070000Z", "o/mine", { status: "merged", pr: 1 }),
  sc("20261118T070000Z", "o/other", { status: "pr_open", pr: 2 }),
  sc("20261118T070000Z", "o/third", { status: "blocked" }),
  // slot B: failed, no-op, stuck (PR open 30h), pending
  sc("20261117T070000Z", "o/mine", { status: "cancelled" }),
  sc("20261117T070000Z", "o/other", { status: "done" }),
  sc("20261117T070000Z", "o/third", { status: "pr_open", pr: 3 }),
  sc("20261117T070000Z", "o/fourth", { status: "pending" }),
  // follow-on from the same cron: one shipped, one not
  {
    id: "F-1",
    status: "merged",
    repo: "o/mine",
    pr: null,
    source: "human",
    originKind: "cron",
    originRef: "test-readiness",
    createdAt: ago(3),
  },
  {
    id: "F-2",
    status: "pending",
    repo: "o/other",
    pr: null,
    source: "human",
    originKind: "cron",
    originRef: "test-readiness",
    createdAt: ago(3),
  },
  // outside the range: must not be counted
  sc("20261001T070000Z", "o/mine", {
    status: "merged",
    createdAt: "2026-10-01T07:00:00.000Z",
  }),
  // another cron
  sc("20261118T080000Z", "o/mine", {
    id: "SC-docs-freshness-20261118T080000Z-o-mine",
    originRef: "docs-freshness",
    status: "deployed",
  }),
];

const PRS: PrRecord[] = [
  {
    id: "p2",
    repo: "o/other",
    prNumber: 2,
    state: "open",
    createdAt: ago(2),
    mergedAt: null,
  },
  {
    id: "p3",
    repo: "o/third",
    prNumber: 3,
    state: "open",
    createdAt: ago(30),
    mergedAt: null,
  },
] as PrRecord[];

function fakeStore() {
  const urls: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    urls.push(input);
    const url = new URL(input);
    const token = (init?.headers?.Authorization ?? "").replace("Bearer ", "");
    const json = (body: unknown, status = 200) => ({
      ok: status < 400,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    });
    if (url.pathname === "/system-crons") {
      if (token !== ADMIN) return json({ error: "forbidden" }, 403);
      return json({
        systemCrons: [
          {
            id: "docs-freshness",
            accountId: "default",
            name: "Docs",
            schedule: "0 8 * * *",
            enabled: true,
          },
          {
            id: "test-readiness",
            accountId: "default",
            name: "Test readiness",
            schedule: "0 7 * * *",
            enabled: true,
          },
          {
            id: "dep-audit",
            accountId: "default",
            name: "Dep audit",
            schedule: "0 9 * * 1",
            enabled: false,
          },
        ],
      });
    }
    if (url.pathname === "/prs") {
      return json({ prs: PRS, total: PRS.length });
    }
    if (url.pathname === "/tasks") {
      const q = url.searchParams;
      let rows = TASKS.filter(
        (t) =>
          t.originKind === q.get("originKind") &&
          t.originRef === q.get("originRef") &&
          Date.parse(t.createdAt as string) >=
            Date.parse(q.get("createdFrom") as string) &&
          Date.parse(t.createdAt as string) <=
            Date.parse(q.get("createdTo") as string),
      );
      if (token === AGENT) {
        rows = rows.filter(
          (t) =>
            t.assignee === "agent" || AGENT_REPOS.includes(t.repo as string),
        );
      }
      return json({ tasks: rows, total: rows.length });
    }
    return json({ error: "not found" }, 404);
  };
  return { fetch, urls };
}

const provider = (token: string) => {
  const store = fakeStore();
  return {
    store,
    p: new TaskStoreProvider(
      new HttpTaskStoreClient("http://store", token, store.fetch),
      // biome-ignore lint/suspicious/noExplicitAny: admin client unused by systemCrons
      {} as any,
      FixedClock(NOW),
    ),
  };
};

describe("TaskStoreProvider.systemCrons (account-wide token)", () => {
  test("lists every registered cron, 0 for crons that created nothing", async () => {
    const { p } = provider(ADMIN);
    const r = await p.systemCrons("7d");
    expect(r.crons.map((c) => c.id)).toEqual([
      "docs-freshness",
      "test-readiness",
      "dep-audit",
    ]);
    const dep = r.crons[2];
    expect(dep.tasksCreated.count).toBe(0);
    expect(dep.fires.count).toBe(0);
    expect(Object.values(dep.buckets).every((b) => b.count === 0)).toBe(true);
    expect(dep.followOn.created.count).toBe(0);
  });

  test("buckets, fires and follow-ons for the seeded cron", async () => {
    const { p } = provider(ADMIN);
    const row = (await p.systemCrons("7d")).crons.find(
      (c) => c.id === "test-readiness",
    );
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.fires.count).toBe(2);
    expect(row.tasksCreated.count).toBe(7);
    expect({
      shipped: row.buckets.shipped.count,
      inFlight: row.buckets.inFlight.count,
      stuck: row.buckets.stuck.count,
      failed: row.buckets.failed.count,
      noOp: row.buckets.noOp.count,
      pending: row.buckets.pending.count,
    }).toEqual({
      shipped: 1,
      inFlight: 1,
      stuck: 2,
      failed: 1,
      noOp: 1,
      pending: 1,
    });
    // buckets partition the created tasks
    expect(Object.values(row.buckets).reduce((n, b) => n + b.count, 0)).toBe(
      row.tasksCreated.count,
    );
    expect(row.followOn.created.count).toBe(2);
    expect(row.followOn.shipped.count).toBe(1);
  });

  test("every count carries drill-down filter params; meta is populated", async () => {
    const { p } = provider(ADMIN);
    const r = await p.systemCrons("7d");
    const row = r.crons.find((c) => c.id === "test-readiness");
    if (!row) throw new Error("missing row");
    expect(row.buckets.failed.filter).toMatchObject({
      originKind: "cron",
      originRef: "test-readiness",
      createdFrom: r.from,
      createdTo: r.to,
      source: "system-cron",
      status: "cancelled",
    });
    expect(row.followOn.created.filter).toMatchObject({
      originKind: "cron",
      originRef: "test-readiness",
      sourceNot: "system-cron",
    });
    expect(r.meta).toEqual({
      generatedAt: NOW,
      repoCount: 4,
      accountId: "default",
    });
  });

  test("sends originKind/originRef and the createdAt range, with the account-wide token", async () => {
    const { p, store } = provider(ADMIN);
    const r = await p.systemCrons("7d");
    const taskUrls = store.urls
      .map((u) => new URL(u))
      .filter((u) => u.pathname === "/tasks");
    expect(taskUrls).toHaveLength(3);
    for (const u of taskUrls) {
      expect(u.searchParams.get("originKind")).toBe("cron");
      expect(u.searchParams.get("createdFrom")).toBe(r.from);
      expect(u.searchParams.get("createdTo")).toBe(r.to);
    }
    expect(taskUrls.map((u) => u.searchParams.get("originRef")).sort()).toEqual(
      ["dep-audit", "docs-freshness", "test-readiness"],
    );
  });

  test("the agent token cannot read the registry (403) — why the service uses its own token", async () => {
    const { p } = provider(AGENT);
    await expect(p.systemCrons("7d")).rejects.toThrow(/403/);
  });
});
