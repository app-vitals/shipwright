/**
 * metrics/src/lib/task-store-client.unit.test.ts
 * Unit: HttpTaskStoreClient paginates past the server limit and applies
 * client-side date-window filtering (the live `/tasks` and `/prs` routes ignore
 * from/to and truncate at the default limit). Uses an injected fetch double —
 * no global override (Bun shares the test process).
 */

import { describe, expect, test } from "bun:test";
import {
  type FetchLike,
  HttpTaskStoreClient,
  type PrRecord,
  type TaskRecord,
} from "./task-store-client.ts";

/** Server-side max page the live store enforces regardless of requested limit. */
const SERVER_MAX_PAGE = 50;

/** Build a fetch double that pages a fixed dataset under `key`. Like the live
 * store, it caps the effective page at `SERVER_MAX_PAGE` even when the client
 * asks for more — so the client must loop on `offset` to read everything.
 * Reports a `total` and records each requested URL for assertions. */
function pagingFetch<T>(
  key: "tasks" | "prs" | "snapshots",
  rows: T[],
): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (input) => {
    calls.push(input);
    const url = new URL(input);
    const requested = Number(url.searchParams.get("limit") ?? "50");
    const limit = Math.min(requested, SERVER_MAX_PAGE);
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const page = rows.slice(offset, offset + limit);
    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ [key]: page, total: rows.length, limit, offset }),
    };
  };
  return { fetch, calls };
}

describe("HttpTaskStoreClient pagination", () => {
  test("listPrs fetches every page past the server default limit", async () => {
    // 130 PRs — more than one page; none have anchor timestamps so an open
    // window keeps them all.
    const prs: PrRecord[] = Array.from({ length: 130 }, (_, i) => ({
      id: `pr-${i}`,
      reviewState: "approved",
    }));
    const { fetch, calls } = pagingFetch("prs", prs);
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);

    const got = await client.listPrs({});
    expect(got.length).toBe(130);
    // More than one request was made (paginated, not truncated at 50).
    expect(calls.length).toBeGreaterThan(1);
  });

  test("listTasks fetches every page past the server default limit", async () => {
    const tasks: TaskRecord[] = Array.from({ length: 75 }, (_, i) => ({
      id: `T-${i}`,
      status: "merged",
    }));
    const { fetch } = pagingFetch("tasks", tasks);
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);

    const got = await client.listTasks({});
    expect(got.length).toBe(75);
  });
});

describe("HttpTaskStoreClient client-side window filtering", () => {
  test("listTasks drops tasks whose anchor is outside [from,to]", async () => {
    const tasks: TaskRecord[] = [
      { id: "IN-1", status: "merged", completedAt: "2026-06-05T00:00:00.000Z" },
      {
        id: "OUT-EARLY",
        status: "merged",
        completedAt: "2026-05-01T00:00:00.000Z",
      },
      {
        id: "OUT-LATE",
        status: "merged",
        completedAt: "2026-08-01T00:00:00.000Z",
      },
    ];
    const { fetch } = pagingFetch("tasks", tasks);
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);

    const got = await client.listTasks({
      from: "2026-06-01",
      to: "2026-06-30",
    });
    expect(got.map((t) => t.id)).toEqual(["IN-1"]);
  });

  test("listPrs filters on mergedAt anchor, falling back to createdAt", async () => {
    const prs: PrRecord[] = [
      {
        id: "merged-in",
        reviewState: "approved",
        mergedAt: "2026-06-10T00:00:00.000Z",
      },
      {
        id: "created-in",
        reviewState: "posted",
        createdAt: "2026-06-12T00:00:00.000Z",
      },
      {
        id: "out",
        reviewState: "approved",
        mergedAt: "2026-05-01T00:00:00.000Z",
      },
    ];
    const { fetch } = pagingFetch("prs", prs);
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);

    const got = await client.listPrs({ from: "2026-06-01", to: "2026-06-30" });
    expect(got.map((p) => p.id).sort()).toEqual(["created-in", "merged-in"]);
  });

  test("an open window (no from/to) keeps all rows", async () => {
    const tasks: TaskRecord[] = [
      {
        id: "anchored",
        status: "merged",
        completedAt: "2020-01-01T00:00:00.000Z",
      },
      { id: "no-anchor", status: "pending" },
    ];
    const { fetch } = pagingFetch("tasks", tasks);
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);

    const got = await client.listTasks({});
    expect(got.length).toBe(2);
  });
});

describe("HttpTaskStoreClient server-side query params", () => {
  test("listTasks sends updatedSince and repo in the query string", async () => {
    const { fetch, calls } = pagingFetch<TaskRecord>("tasks", []);
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);

    await client.listTasks({ from: "2026-06-01", repo: "org/alpha" });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const url = new URL(call);
      expect(url.searchParams.get("updatedSince")).toBe("2026-06-01");
      expect(url.searchParams.get("repo")).toBe("org/alpha");
    }
  });

  test("listPrs sends updatedSince and repo in the query string", async () => {
    const { fetch, calls } = pagingFetch<PrRecord>("prs", []);
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);

    await client.listPrs({ from: "2026-06-01", repo: "org/beta" });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const url = new URL(call);
      expect(url.searchParams.get("updatedSince")).toBe("2026-06-01");
      expect(url.searchParams.get("repo")).toBe("org/beta");
    }
  });

  test("listTasks omits updatedSince/repo from the query string when not provided", async () => {
    const { fetch, calls } = pagingFetch<TaskRecord>("tasks", []);
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);

    await client.listTasks({});
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const url = new URL(call);
      expect(url.searchParams.has("updatedSince")).toBe(false);
      expect(url.searchParams.has("repo")).toBe(false);
    }
  });

  test("listPrs omits updatedSince/repo from the query string when not provided", async () => {
    const { fetch, calls } = pagingFetch<PrRecord>("prs", []);
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);

    await client.listPrs({});
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const url = new URL(call);
      expect(url.searchParams.has("updatedSince")).toBe(false);
      expect(url.searchParams.has("repo")).toBe(false);
    }
  });
});

describe("HttpTaskStoreClient repo filtering", () => {
  test("listTasks returns only tasks matching params.repo", async () => {
    const tasks: TaskRecord[] = [
      { id: "A-1", status: "merged", repo: "org/alpha" },
      { id: "B-1", status: "merged", repo: "org/beta" },
      { id: "A-2", status: "done", repo: "org/alpha" },
    ];
    const { fetch } = pagingFetch("tasks", tasks);
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);

    const got = await client.listTasks({ repo: "org/alpha" });
    expect(got.map((t) => t.id).sort()).toEqual(["A-1", "A-2"]);
  });

  test("listPrs returns only PRs matching params.repo", async () => {
    const prs: PrRecord[] = [
      { id: "pr-a", reviewState: "approved", repo: "org/alpha" },
      { id: "pr-b", reviewState: "posted", repo: "org/beta" },
    ];
    const { fetch } = pagingFetch("prs", prs);
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);

    const got = await client.listPrs({ repo: "org/beta" });
    expect(got.map((p) => p.id)).toEqual(["pr-b"]);
  });

  test("no repo param keeps records from every repo", async () => {
    const tasks: TaskRecord[] = [
      { id: "A-1", status: "merged", repo: "org/alpha" },
      { id: "B-1", status: "merged", repo: "org/beta" },
      { id: "C-1", status: "merged", repo: null },
    ];
    const { fetch } = pagingFetch("tasks", tasks);
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);

    const got = await client.listTasks({});
    expect(got.length).toBe(3);
  });

  test("repo filter excludes records with a null/absent repo", async () => {
    const tasks: TaskRecord[] = [
      { id: "A-1", status: "merged", repo: "org/alpha" },
      { id: "N-1", status: "merged", repo: null },
      { id: "N-2", status: "merged" },
    ];
    const { fetch } = pagingFetch("tasks", tasks);
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);

    const got = await client.listTasks({ repo: "org/alpha" });
    expect(got.map((t) => t.id)).toEqual(["A-1"]);
  });
});

describe("HttpTaskStoreClient coverage snapshots (CVT-3.1)", () => {
  const snap = (repo: string, sha: string) => ({
    repo,
    commitSha: sha,
    linesPct: 80,
    branchesPct: null,
    functionsPct: null,
    measuredAt: "2026-06-10T00:00:00.000Z",
  });

  test("listLatestCoverage reads /coverage-snapshots/latest and scopes by repo", async () => {
    const calls: string[] = [];
    const client = new HttpTaskStoreClient(
      "http://store/",
      "tok",
      async (input) => {
        calls.push(input);
        return {
          ok: true,
          status: 200,
          text: async () => "",
          json: async () => ({
            snapshots: [snap("org/a", "1"), snap("org/b", "2")],
          }),
        };
      },
    );
    const got = await client.listCoverageHistory({ limit: 2, repo: "org/a" });
    expect(calls[0]).toBe(
      "http://store/coverage-snapshots?repo=org%2Fa&limit=2",
    );
    expect(got).toHaveLength(2);
    const latest = await client.listLatestCoverage({ repo: "org/b" });
    expect(calls[1]).toBe("http://store/coverage-snapshots/latest");
    expect(latest.map((s) => s.commitSha)).toEqual(["2"]);
  });

  test("listCoverageHistory without limit pages past the server cap", async () => {
    const rows = Array.from({ length: 130 }, (_, i) => snap("org/a", `c${i}`));
    const { fetch, calls } = pagingFetch("snapshots", rows);
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);
    const got = await client.listCoverageHistory({ since: "2026-06-01" });
    expect(got).toHaveLength(130);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]).toContain("since=2026-06-01");
  });
});

describe("HttpTaskStoreClient system-cron reads (SCM-8.3)", () => {
  test("listSystemCrons unwraps { systemCrons }", async () => {
    const fetch: FetchLike = async (input) => {
      expect(new URL(input).pathname).toBe("/system-crons");
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
          systemCrons: [
            {
              id: "a",
              accountId: "x",
              name: "A",
              schedule: "* * * * *",
              enabled: true,
            },
          ],
        }),
      };
    };
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);
    expect((await client.listSystemCrons()).map((c) => c.id)).toEqual(["a"]);
  });

  test("listCronTasks sends originKind/originRef/createdFrom/createdTo and pages", async () => {
    const rows: TaskRecord[] = Array.from({ length: 60 }, (_, i) => ({
      id: `SC-a-${i}`,
      status: "pending",
    }));
    const { fetch, calls } = pagingFetch("tasks", rows);
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);
    const got = await client.listCronTasks({
      originRef: "a",
      createdFrom: "2026-11-01T00:00:00.000Z",
      createdTo: "2026-11-02T00:00:00.000Z",
    });
    expect(got).toHaveLength(60);
    const u = new URL(calls[0]);
    expect(u.pathname).toBe("/tasks");
    expect(u.searchParams.get("originKind")).toBe("cron");
    expect(u.searchParams.get("originRef")).toBe("a");
    expect(u.searchParams.get("createdFrom")).toBe("2026-11-01T00:00:00.000Z");
    expect(u.searchParams.get("createdTo")).toBe("2026-11-02T00:00:00.000Z");
  });

  test("listPrsUpdatedSince passes updatedSince and does not window-filter", async () => {
    const prs = [
      { id: "p", mergedAt: "2020-01-01T00:00:00.000Z" },
    ] as PrRecord[];
    const { fetch, calls } = pagingFetch("prs", prs);
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);
    expect(
      await client.listPrsUpdatedSince("2026-11-01T00:00:00.000Z"),
    ).toHaveLength(1);
    expect(new URL(calls[0]).searchParams.get("updatedSince")).toBe(
      "2026-11-01T00:00:00.000Z",
    );
  });
});
