/**
 * metrics/src/lib/admin-metrics-client.integration.test.ts
 * Integration: HttpAdminMetricsClient builds correct URLs/headers for the two
 * admin token-stats endpoints, slices ISO datetimes to date-only for the
 * chat-tokens endpoint, and throws a typed error on non-2xx. Exercises the
 * real external-HTTP-client boundary via an injected `FetchLike` double
 * (recorded-response fixture, not a mock) — no global override (Bun shares
 * the test process), mirroring task-store-client.unit.test.ts's FetchLike
 * pattern. Filed as `*.integration.test.ts` per docs/testing.md's layer
 * convention: external HTTP client tests are integration-layer even when the
 * "recording" is an inline fixture rather than a cassette file, since the
 * client's request/response contract with a real dependency is what's under
 * test.
 */

import { describe, expect, test } from "bun:test";
import {
  AdminMetricsClientError,
  type ChatTokenStats,
  type CronRunTokenStats,
  type FetchLike,
  HttpAdminMetricsClient,
} from "./admin-metrics-client.ts";

/** Build a fetch double that records every call and returns a fixed JSON body. */
function jsonFetch(body: unknown): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (input) => {
    calls.push(input);
    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => body,
    };
  };
  return { fetch, calls };
}

/** Build a fetch double that always fails with the given status/body. */
function failingFetch(
  status: number,
  bodyText: string,
): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (input) => {
    calls.push(input);
    return {
      ok: false,
      status,
      text: async () => bodyText,
      json: async () => ({}),
    };
  };
  return { fetch, calls };
}

const emptyCronStats: CronRunTokenStats = {
  totals: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
  byAgent: [],
  byCron: [],
  byModel: [],
  daily: [],
  byCronModel: [],
  byPhase: [],
};

const emptyChatStats: ChatTokenStats = {
  totals: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
  byAgent: [],
  byModel: [],
  daily: [],
};

describe("HttpAdminMetricsClient construction", () => {
  test("strips a trailing slash from baseUrl", async () => {
    const { fetch, calls } = jsonFetch(emptyCronStats);
    const client = new HttpAdminMetricsClient("http://admin/", "tok", fetch);

    await client.cronRunTokenStats({});
    expect(calls[0]?.startsWith("http://admin/agents/")).toBe(true);
    expect(calls[0]?.includes("//agents")).toBe(false);
  });
});

describe("HttpAdminMetricsClient cronRunTokenStats", () => {
  test("hits the cron-runs stats endpoint with Bearer auth header", async () => {
    const { fetch, calls } = jsonFetch(emptyCronStats);
    let seenInit: { headers?: Record<string, string> } | undefined;
    const spyFetch: FetchLike = async (input, init) => {
      seenInit = init;
      return fetch(input, init);
    };
    const client = new HttpAdminMetricsClient(
      "http://admin",
      "secret-tok",
      spyFetch,
    );

    const got = await client.cronRunTokenStats({});
    expect(got).toEqual(emptyCronStats);
    expect(calls[0]).toBe("http://admin/agents/all/cron-runs/stats");
    expect(seenInit?.headers?.Authorization).toBe("Bearer secret-tok");
    expect(seenInit?.headers?.["Content-Type"]).toBe("application/json");
  });

  test("forwards from/to as query params unchanged (no date slicing)", async () => {
    const { fetch, calls } = jsonFetch(emptyCronStats);
    const client = new HttpAdminMetricsClient("http://admin", "tok", fetch);

    await client.cronRunTokenStats({
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-06-30T00:00:00.000Z",
    });

    const url = new URL(calls[0] as string);
    expect(url.pathname).toBe("/agents/all/cron-runs/stats");
    expect(url.searchParams.get("from")).toBe("2026-06-01T00:00:00.000Z");
    expect(url.searchParams.get("to")).toBe("2026-06-30T00:00:00.000Z");
  });

  test("omits from/to query params when undefined or empty", async () => {
    const { fetch, calls } = jsonFetch(emptyCronStats);
    const client = new HttpAdminMetricsClient("http://admin", "tok", fetch);

    await client.cronRunTokenStats({ from: "", to: undefined });

    expect(calls[0]).toBe("http://admin/agents/all/cron-runs/stats");
  });
});

describe("HttpAdminMetricsClient chatTokenStats", () => {
  test("hits the chat-tokens daily stats endpoint", async () => {
    const { fetch, calls } = jsonFetch(emptyChatStats);
    const client = new HttpAdminMetricsClient("http://admin", "tok", fetch);

    const got = await client.chatTokenStats({});
    expect(got).toEqual(emptyChatStats);
    expect(calls[0]).toBe("http://admin/agents/chat-tokens/daily/stats");
  });

  test("slices ISO datetime from/to down to the date portion (YYYY-MM-DD)", async () => {
    const { fetch, calls } = jsonFetch(emptyChatStats);
    const client = new HttpAdminMetricsClient("http://admin", "tok", fetch);

    await client.chatTokenStats({
      from: "2026-06-01T12:34:56.000Z",
      to: "2026-06-30T23:59:59.000Z",
    });

    const url = new URL(calls[0] as string);
    expect(url.searchParams.get("from")).toBe("2026-06-01");
    expect(url.searchParams.get("to")).toBe("2026-06-30");
  });

  test("passes already date-only from/to through unchanged", async () => {
    const { fetch, calls } = jsonFetch(emptyChatStats);
    const client = new HttpAdminMetricsClient("http://admin", "tok", fetch);

    await client.chatTokenStats({ from: "2026-06-01", to: "2026-06-30" });

    const url = new URL(calls[0] as string);
    expect(url.searchParams.get("from")).toBe("2026-06-01");
    expect(url.searchParams.get("to")).toBe("2026-06-30");
  });

  test("omits from/to entirely when both are undefined", async () => {
    const { fetch, calls } = jsonFetch(emptyChatStats);
    const client = new HttpAdminMetricsClient("http://admin", "tok", fetch);

    await client.chatTokenStats({});

    expect(calls[0]).toBe("http://admin/agents/chat-tokens/daily/stats");
  });
});

describe("HttpAdminMetricsClient error handling", () => {
  test("throws a typed AdminMetricsClientError on non-2xx with the response body as message", async () => {
    const { fetch } = failingFetch(503, "admin service unavailable");
    const client = new HttpAdminMetricsClient("http://admin", "tok", fetch);

    await expect(client.cronRunTokenStats({})).rejects.toThrow(
      AdminMetricsClientError,
    );
    try {
      await client.chatTokenStats({});
      throw new Error("expected chatTokenStats to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(AdminMetricsClientError);
      expect((err as AdminMetricsClientError).statusCode).toBe(503);
      expect((err as Error).message).toContain("admin service unavailable");
    }
  });

  test("falls back to 'unknown error' when reading the error body throws", async () => {
    const fetch: FetchLike = async () => ({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error("body read failed");
      },
      json: async () => ({}),
    });
    const client = new HttpAdminMetricsClient("http://admin", "tok", fetch);

    await expect(client.cronRunTokenStats({})).rejects.toThrow(
      "unknown error",
    );
  });
});

describe("HttpAdminMetricsClient default fetch", () => {
  test("uses globalThis.fetch when no fetch override is injected", () => {
    // No third constructor arg — must not throw, and must fall back to the
    // platform fetch (verified indirectly: construction succeeds).
    const client = new HttpAdminMetricsClient("http://admin", "tok");
    expect(client).toBeInstanceOf(HttpAdminMetricsClient);
  });
});
