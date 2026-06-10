/**
 * metrics/src/posthog-client.test.ts
 * Tests for PostHog HogQL client — uses DI fetch, no mock.module().
 */

import { describe, expect, it } from "bun:test";
import { Cache } from "./cache.ts";
import { PostHogClientError, createPostHogClient } from "./posthog-client.ts";
import type {
  FetchFn,
  HogQLMetadataResponse,
  HogQLResponse,
  HogQLResult,
} from "./types.ts";

const TEST_CONFIG = {
  personalApiKey: "phx_test_key_123",
  projectId: "12345",
  baseUrl: "https://posthog.test",
};

/** Helper: create a mock fetch that returns a given response and captures calls */
function mockFetch(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): FetchFn & { lastInput?: string | URL | Request; lastInit?: RequestInit } {
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    fn.lastInput = input;
    fn.lastInit = init;

    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    });
  };
  fn.lastInput = undefined as string | URL | Request | undefined;
  fn.lastInit = undefined as RequestInit | undefined;
  return fn as FetchFn & {
    lastInput?: string | URL | Request;
    lastInit?: RequestInit;
  };
}

/** Helper: create a fetch that rejects with network error */
function failingFetch(error: Error): FetchFn {
  return async (
    _input: URL | RequestInfo,
    _init?: RequestInit | BunFetchRequestInit,
  ) => {
    throw error;
  };
}

const VALID_RESPONSE: HogQLResponse = {
  results: [
    ["task_completed", 42],
    ["ci_gate_passed", 38],
  ],
  columns: ["event", "count"],
  types: ["String", "UInt64"],
  hasMore: false,
  limit: 100,
  offset: 0,
};

describe("createPostHogClient", () => {
  describe("successful queries", () => {
    it("sends authenticated HogQL query and returns parsed result", async () => {
      const fetch = mockFetch(200, VALID_RESPONSE);
      const client = createPostHogClient(TEST_CONFIG, fetch);

      const result = await client.query(
        "SELECT event, count() FROM events GROUP BY event",
      );

      expect(result.columns).toEqual(["event", "count"]);
      expect(result.results).toEqual([
        ["task_completed", 42],
        ["ci_gate_passed", 38],
      ]);
      expect(result.types).toEqual(["String", "UInt64"]);
      expect(result.hasMore).toBe(false);
    });

    it("sends correct URL with project ID", async () => {
      const fetch = mockFetch(200, VALID_RESPONSE);
      const client = createPostHogClient(TEST_CONFIG, fetch);

      await client.query("SELECT 1");

      const lastInput = fetch.lastInput;
      expect(lastInput).toBe("https://posthog.test/api/projects/12345/query/");
    });

    it("includes Authorization header with personal API key", async () => {
      const fetch = mockFetch(200, VALID_RESPONSE);
      const client = createPostHogClient(TEST_CONFIG, fetch);

      await client.query("SELECT 1");

      expect(fetch.lastInit).toBeDefined();
      const headers = fetch.lastInit?.headers as Record<string, string>;
      expect(headers?.Authorization).toBe("Bearer phx_test_key_123");
    });

    it("sends HogQL query in request body", async () => {
      const fetch = mockFetch(200, VALID_RESPONSE);
      const client = createPostHogClient(TEST_CONFIG, fetch);

      await client.query("SELECT event FROM events LIMIT 10");

      expect(fetch.lastInit).toBeDefined();
      const body = JSON.parse(fetch.lastInit?.body as string);
      expect(body.query.kind).toBe("HogQLQuery");
      expect(body.query.query).toBe("SELECT event FROM events LIMIT 10");
    });

    it("includes date range filters when provided", async () => {
      const fetch = mockFetch(200, VALID_RESPONSE);
      const client = createPostHogClient(TEST_CONFIG, fetch);

      await client.query("SELECT event FROM events", {
        dateFrom: "2026-04-01",
        dateTo: "2026-04-03",
      });

      expect(fetch.lastInit).toBeDefined();
      const body = JSON.parse(fetch.lastInit?.body as string);
      expect(body.query.filters.dateRange.date_from).toBe("2026-04-01");
      expect(body.query.filters.dateRange.date_to).toBe("2026-04-03");
    });

    it("uses default base URL when not specified", async () => {
      const fetch = mockFetch(200, VALID_RESPONSE);
      const client = createPostHogClient(
        { personalApiKey: "key", projectId: "99" },
        fetch,
      );

      await client.query("SELECT 1");

      const lastInput = fetch.lastInput;
      expect(lastInput).toBe("https://us.posthog.com/api/projects/99/query/");
    });
  });

  describe("error handling", () => {
    it("throws PostHogClientError on 401 auth failure", async () => {
      const fetch = mockFetch(401, { detail: "Invalid API key" });
      const client = createPostHogClient(TEST_CONFIG, fetch);

      try {
        await client.query("SELECT 1");
        expect(true).toBe(false); // should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(PostHogClientError);
        expect((err as PostHogClientError).statusCode).toBe(401);
        expect((err as PostHogClientError).message).toContain(
          "authentication failed",
        );
      }
    });

    it("throws PostHogClientError on 429 rate limit with retry-after", async () => {
      const fetch = mockFetch(
        429,
        { detail: "Rate limited" },
        {
          "retry-after": "30",
        },
      );
      const client = createPostHogClient(TEST_CONFIG, fetch);

      try {
        await client.query("SELECT 1");
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(PostHogClientError);
        expect((err as PostHogClientError).statusCode).toBe(429);
        expect((err as PostHogClientError).retryAfter).toBe(30);
        expect((err as PostHogClientError).message).toContain("rate limit");
      }
    });

    it("throws PostHogClientError on 500 server error", async () => {
      const fetch = mockFetch(500, { detail: "Internal error" });
      const client = createPostHogClient(TEST_CONFIG, fetch);

      try {
        await client.query("SELECT 1");
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(PostHogClientError);
        expect((err as PostHogClientError).statusCode).toBe(500);
      }
    });

    it("propagates network errors from fetch", async () => {
      const fetch = failingFetch(new Error("ECONNREFUSED"));
      const client = createPostHogClient(TEST_CONFIG, fetch);

      try {
        await client.query("SELECT 1");
        expect(true).toBe(false);
      } catch (err) {
        expect((err as Error).message).toBe("ECONNREFUSED");
      }
    });

    it("defaults retry-after to 60 when header is missing", async () => {
      const fetch = mockFetch(429, { detail: "Rate limited" });
      const client = createPostHogClient(TEST_CONFIG, fetch);

      try {
        await client.query("SELECT 1");
        expect(true).toBe(false);
      } catch (err) {
        expect((err as PostHogClientError).retryAfter).toBe(60);
      }
    });
  });

  describe("caching", () => {
    it("returns cached result without calling fetch on second query", async () => {
      let callCount = 0;
      const countingFetch: FetchFn = async () => {
        callCount++;
        return new Response(JSON.stringify(VALID_RESPONSE), { status: 200 });
      };

      const cache = new Cache<HogQLResult>();
      const client = createPostHogClient(TEST_CONFIG, countingFetch, cache);

      await client.query("SELECT event FROM events");
      await client.query("SELECT event FROM events");

      expect(callCount).toBe(1);
    });

    it("cache miss triggers fetch when query differs", async () => {
      let callCount = 0;
      const countingFetch: FetchFn = async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        callCount++;
        return new Response(JSON.stringify(VALID_RESPONSE), { status: 200 });
      };

      const cache = new Cache<HogQLResult>();
      const client = createPostHogClient(TEST_CONFIG, countingFetch, cache);

      await client.query("SELECT event FROM events");
      await client.query("SELECT count() FROM events");

      expect(callCount).toBe(2);
    });

    it("returns fresh result after TTL expiry", async () => {
      let callCount = 0;
      const countingFetch: FetchFn = async () => {
        callCount++;
        return new Response(JSON.stringify(VALID_RESPONSE), { status: 200 });
      };

      const cache = new Cache<HogQLResult>();
      const client = createPostHogClient(TEST_CONFIG, countingFetch, cache, 10); // 10ms TTL

      await client.query("SELECT event FROM events");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await client.query("SELECT event FROM events");

      expect(callCount).toBe(2);
    });

    it("cache.clear() causes next call to hit fetch", async () => {
      let callCount = 0;
      const countingFetch: FetchFn = async () => {
        callCount++;
        return new Response(JSON.stringify(VALID_RESPONSE), { status: 200 });
      };

      const cache = new Cache<HogQLResult>();
      const client = createPostHogClient(TEST_CONFIG, countingFetch, cache);

      await client.query("SELECT event FROM events");
      client.clearCache();
      await client.query("SELECT event FROM events");

      expect(callCount).toBe(2);
    });

    it("does not cache failed requests (4xx/5xx)", async () => {
      let callCount = 0;
      const countingFetch: FetchFn = async () => {
        callCount++;
        return new Response(JSON.stringify({ detail: "error" }), {
          status: 500,
        });
      };

      const cache = new Cache<HogQLResult>();
      const client = createPostHogClient(TEST_CONFIG, countingFetch, cache);

      await expect(
        client.query("SELECT event FROM events"),
      ).rejects.toMatchObject({
        name: "PostHogClientError",
      });
      await expect(
        client.query("SELECT event FROM events"),
      ).rejects.toMatchObject({
        name: "PostHogClientError",
      });

      expect(callCount).toBe(2);
      expect(cache.size()).toBe(0);
    });

    it("different date ranges produce separate cache entries", async () => {
      let callCount = 0;
      const countingFetch: FetchFn = async () => {
        callCount++;
        return new Response(JSON.stringify(VALID_RESPONSE), { status: 200 });
      };

      const cache = new Cache<HogQLResult>();
      const client = createPostHogClient(TEST_CONFIG, countingFetch, cache);

      await client.query("SELECT event FROM events", {
        dateFrom: "2026-01-01",
      });
      await client.query("SELECT event FROM events", {
        dateFrom: "2026-02-01",
      });

      expect(callCount).toBe(2);
    });
  });

  describe("validate()", () => {
    const VALID_METADATA_RESPONSE: HogQLMetadataResponse = {
      isValid: true,
      errors: [],
      notices: [],
    };

    const INVALID_METADATA_RESPONSE: HogQLMetadataResponse = {
      isValid: false,
      errors: [
        {
          message:
            "Unsupported function toFloatOrNull called in HogQL expression",
          start: 7,
          end: 20,
        },
      ],
      notices: [],
    };

    it("returns { isValid: true, errors: [] } for a valid query", async () => {
      const fetch = mockFetch(200, VALID_METADATA_RESPONSE);
      const client = createPostHogClient(TEST_CONFIG, fetch);

      const result = await client.validate(
        "SELECT count() FROM events WHERE event = 'pageview'",
      );

      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("returns { isValid: false, errors: [...] } for an invalid query with unsupported function", async () => {
      const fetch = mockFetch(200, INVALID_METADATA_RESPONSE);
      const client = createPostHogClient(TEST_CONFIG, fetch);

      const result = await client.validate(
        "SELECT toFloatOrNull(count()) FROM events",
      );

      expect(result.isValid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain("toFloatOrNull");
      expect(result.errors[0].start).toBe(7);
      expect(result.errors[0].end).toBe(20);
    });

    it("sends correct request body with kind HogQLMetadata, language hogQL, and query", async () => {
      const fetch = mockFetch(200, VALID_METADATA_RESPONSE);
      const client = createPostHogClient(TEST_CONFIG, fetch);
      const hogql = "SELECT count() FROM events";

      await client.validate(hogql);

      const body = JSON.parse(fetch.lastInit?.body as string);
      expect(body.query.kind).toBe("HogQLMetadata");
      expect(body.query.language).toBe("hogQL");
      expect(body.query.query).toBe(hogql);
    });

    it("sends request to the same /api/projects/{id}/query/ endpoint", async () => {
      const fetch = mockFetch(200, VALID_METADATA_RESPONSE);
      const client = createPostHogClient(TEST_CONFIG, fetch);

      await client.validate("SELECT 1");

      expect(fetch.lastInput).toBe(
        "https://posthog.test/api/projects/12345/query/",
      );
    });

    it("surfaces 401 as PostHogClientError with statusCode 401", async () => {
      const fetch = mockFetch(401, { detail: "Invalid API key" });
      const client = createPostHogClient(TEST_CONFIG, fetch);

      try {
        await client.validate("SELECT 1");
        expect(true).toBe(false); // should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(PostHogClientError);
        expect((err as PostHogClientError).statusCode).toBe(401);
        expect((err as PostHogClientError).message).toContain(
          "authentication failed",
        );
      }
    });

    it("surfaces 429 as PostHogClientError with retryAfter from header", async () => {
      const fetch = mockFetch(
        429,
        { detail: "Rate limited" },
        { "retry-after": "45" },
      );
      const client = createPostHogClient(TEST_CONFIG, fetch);

      try {
        await client.validate("SELECT 1");
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(PostHogClientError);
        expect((err as PostHogClientError).statusCode).toBe(429);
        expect((err as PostHogClientError).retryAfter).toBe(45);
        expect((err as PostHogClientError).message).toContain("rate limit");
      }
    });

    it("surfaces non-ok (500) as PostHogClientError", async () => {
      const fetch = mockFetch(500, { detail: "Internal server error" });
      const client = createPostHogClient(TEST_CONFIG, fetch);

      try {
        await client.validate("SELECT 1");
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(PostHogClientError);
        expect((err as PostHogClientError).statusCode).toBe(500);
      }
    });

    it("does NOT cache results — two identical calls both hit fetch", async () => {
      let callCount = 0;
      const countingFetch: FetchFn = async () => {
        callCount++;
        return new Response(JSON.stringify(VALID_METADATA_RESPONSE), {
          status: 200,
        });
      };

      const client = createPostHogClient(TEST_CONFIG, countingFetch);

      await client.validate("SELECT count() FROM events");
      await client.validate("SELECT count() FROM events");

      expect(callCount).toBe(2);
    });
  });
});
