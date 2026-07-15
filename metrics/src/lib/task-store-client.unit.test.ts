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
  key: "tasks" | "prs",
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

  test("listTasks filters on createdAt anchor when completedAt/mergedAt/startedAt all absent", async () => {
    const tasks: TaskRecord[] = [
      {
        id: "created-in",
        status: "pending",
        createdAt: "2026-06-12T00:00:00.000Z",
      },
      {
        id: "created-out",
        status: "pending",
        createdAt: "2026-07-12T00:00:00.000Z",
      },
      {
        id: "started-in",
        status: "in_progress",
        startedAt: "2026-06-15T00:00:00.000Z",
      },
    ];
    const { fetch } = pagingFetch("tasks", tasks);
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);

    const got = await client.listTasks({
      from: "2026-06-01",
      to: "2026-06-30",
    });
    expect(got.map((t) => t.id).sort()).toEqual(["created-in", "started-in"]);
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
