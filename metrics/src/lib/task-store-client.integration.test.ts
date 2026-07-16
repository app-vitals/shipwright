/**
 * metrics/src/lib/task-store-client.integration.test.ts
 * Integration: HttpTaskStoreClient builds correct URLs/headers for the real
 * task-store endpoints it implements (listTasks, listPrs), maps a single-page
 * response into typed records, and throws a typed error on non-2xx. Exercises
 * the real external-HTTP-client boundary via an injected `FetchLike` double
 * that replays recorded cassette fixtures — no global override (Bun shares
 * the test process), no mock.module(). Mirrors
 * accounts-client.integration.test.ts's cassette pattern. Complements
 * task-store-client.unit.test.ts, which covers pagination/date-filter/repo-
 * filter logic with an in-memory synthetic double rather than fixtures.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type FetchLike,
  HttpTaskStoreClient,
  type PrRecord,
  type TaskRecord,
  TaskStoreClientError,
} from "./task-store-client.ts";

// ─── Cassettes ────────────────────────────────────────────────────────────────

interface CassetteEntry {
  status: number;
  body: unknown;
}

function loadCassette(fileName: string): Record<string, CassetteEntry> {
  const path = new URL(`../fixtures/task-store/${fileName}`, import.meta.url)
    .pathname;
  return JSON.parse(readFileSync(path, "utf-8"));
}

const listTasksCassette = loadCassette("list-tasks.json");
const listPrsCassette = loadCassette("list-prs.json");

/** Build an injected FetchLike that replays the cassette entry for `key` and
 * records every call so tests can assert URL/headers. */
function cassetteFetch(
  cassette: Record<string, CassetteEntry>,
  key: string,
): {
  fetch: FetchLike;
  calls: { url: string; headers?: Record<string, string> }[];
} {
  const entry = cassette[key];
  if (!entry) throw new Error(`cassette key not found: ${key}`);
  const calls: { url: string; headers?: Record<string, string> }[] = [];

  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: input, headers: init?.headers });
    const bodyText =
      typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body);
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      text: async () => bodyText,
      json: async () => entry.body,
    };
  };

  return { fetch, calls };
}

// ─── construction ───────────────────────────────────────────────────────────

describe("HttpTaskStoreClient construction", () => {
  test("strips a trailing slash from baseUrl", async () => {
    const { fetch, calls } = cassetteFetch(
      listTasksCassette,
      "listTasks_success",
    );
    const client = new HttpTaskStoreClient("http://store/", "tok", fetch);

    await client.listTasks({});
    expect(calls[0]?.url.startsWith("http://store/tasks")).toBe(true);
    expect(calls[0]?.url.includes("//tasks")).toBe(false);
  });

  test("sends a Bearer auth header and JSON content-type", async () => {
    const { fetch, calls } = cassetteFetch(
      listTasksCassette,
      "listTasks_success",
    );
    const client = new HttpTaskStoreClient("http://store", "secret-tok", fetch);

    await client.listTasks({});

    expect(calls[0]?.headers?.Authorization).toBe("Bearer secret-tok");
    expect(calls[0]?.headers?.["Content-Type"]).toBe("application/json");
  });

  test("uses globalThis.fetch when no fetch override is injected", () => {
    // No third constructor arg — must not throw, and must fall back to the
    // platform fetch (verified indirectly: construction succeeds).
    const client = new HttpTaskStoreClient("http://store", "tok");
    expect(client).toBeInstanceOf(HttpTaskStoreClient);
  });
});

// ─── listTasks ───────────────────────────────────────────────────────────────

describe("HttpTaskStoreClient listTasks", () => {
  test("returns the mapped TaskRecord[] on a 200 response", async () => {
    const { fetch, calls } = cassetteFetch(
      listTasksCassette,
      "listTasks_success",
    );
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);

    const got = await client.listTasks({});

    expect(calls[0]?.url).toContain("/tasks");
    const expected: TaskRecord[] = [
      {
        id: "T-001",
        status: "merged",
        session: "session-1",
        layer: "unit",
        repo: "org/alpha",
        hours: 2.5,
        complexity: 3,
        startedAt: "2026-06-01T00:00:00.000Z",
        completedAt: "2026-06-01T04:00:00.000Z",
        mergedAt: "2026-06-01T05:00:00.000Z",
        createdAt: "2026-05-31T23:00:00.000Z",
        model: "sonnet",
        effortLevel: "medium",
      },
      {
        id: "T-002",
        status: "in_progress",
        session: null,
        layer: "integration",
        repo: "org/beta",
        hours: null,
        complexity: null,
        startedAt: "2026-06-02T00:00:00.000Z",
        completedAt: null,
        mergedAt: null,
        createdAt: "2026-06-01T22:00:00.000Z",
        model: "opus",
        effortLevel: "high",
      },
    ];
    expect(got).toEqual(expected);
  });

  test("throws TaskStoreClientError with statusCode and body text on a 503", async () => {
    const { fetch } = cassetteFetch(
      listTasksCassette,
      "listTasks_server_error",
    );
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);

    try {
      await client.listTasks({});
      throw new Error("expected listTasks to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(TaskStoreClientError);
      expect((err as TaskStoreClientError).statusCode).toBe(503);
      expect((err as Error).message).toContain("task store unavailable");
    }
  });
});

// ─── listPrs ─────────────────────────────────────────────────────────────────

describe("HttpTaskStoreClient listPrs", () => {
  test("returns the mapped PrRecord[] on a 200 response", async () => {
    const { fetch, calls } = cassetteFetch(listPrsCassette, "listPrs_success");
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);

    const got = await client.listPrs({});

    expect(calls[0]?.url).toContain("/prs");
    const expected: PrRecord[] = [
      {
        id: "pr-101",
        taskId: "T-001",
        reviewState: "approved",
        createdAt: "2026-06-01T04:30:00.000Z",
        mergedAt: "2026-06-01T05:00:00.000Z",
        repo: "org/alpha",
        reviewCycles: 1,
        patchCycles: 0,
      },
      {
        id: "pr-102",
        taskId: "T-002",
        reviewState: "pending",
        createdAt: "2026-06-02T01:00:00.000Z",
        mergedAt: null,
        repo: "org/beta",
        reviewCycles: 0,
        patchCycles: 0,
      },
    ];
    expect(got).toEqual(expected);
  });

  test("throws TaskStoreClientError with statusCode and body text on a 404", async () => {
    const { fetch } = cassetteFetch(listPrsCassette, "listPrs_not_found");
    const client = new HttpTaskStoreClient("http://store", "tok", fetch);

    try {
      await client.listPrs({});
      throw new Error("expected listPrs to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(TaskStoreClientError);
      expect((err as TaskStoreClientError).statusCode).toBe(404);
      expect((err as Error).message).toContain("prs route not found");
    }
  });
});
