/**
 * mcp-server/src/tool-caller.integration.test.ts
 * Integration tests for callTool's real proxied-call path against recorded
 * task-store API fixtures.
 *
 * Drives callTool through an INJECTED fetchImpl that replays canned Responses
 * from a cassette keyed by scenario — no live task-store server, no
 * global.fetch override, no mock.module(). Companion to tool-caller.unit.test.ts
 * (pure proxy-mapping logic with hand-built fakes); this file exercises the
 * same code path against realistic task-store fixture payloads across real
 * generated tool definitions, and mirrors the cassette pattern in
 * admin/src/google-auth-client.integration.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { generatedTools } from "./generated-tools.ts";
import type { GeneratedTool } from "./generated-tools.ts";
import { callTool } from "./tool-caller.ts";

// ─── Cassette ───────────────────────────────────────────────────────────────

interface CassetteEntry {
  status: number;
  body: unknown;
}

const CASSETTE_PATH = new URL(
  "./fixtures/tool-caller-cassette.json",
  import.meta.url,
).pathname;

const cassette: Record<string, CassetteEntry> = JSON.parse(
  readFileSync(CASSETTE_PATH, "utf-8"),
);

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
}

/**
 * Build an injected fetchImpl that returns the cassette entry for `key`.
 * Records the last request so tests can assert URL/method/headers/body.
 */
function cassetteFetch(key: string): {
  fetchImpl: typeof fetch;
  lastRequest: () => RecordedRequest;
} {
  let last: RecordedRequest | undefined;
  const entry = cassette[key];
  if (!entry) throw new Error(`cassette key not found: ${key}`);

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    last = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    const isRaw = typeof entry.body === "string";
    // A null body models a 204-style response, which the Fetch spec forbids
    // pairing with a non-null body — everything else is JSON unless already
    // a raw string (e.g. a plain-text error page).
    const bodyValue =
      entry.body === null
        ? null
        : isRaw
          ? (entry.body as string)
          : JSON.stringify(entry.body);
    return new Response(bodyValue, {
      status: entry.status,
      headers:
        bodyValue === null
          ? undefined
          : { "content-type": isRaw ? "text/plain" : "application/json" },
    });
  }) as typeof fetch;

  return {
    fetchImpl,
    lastRequest: () => {
      if (!last) throw new Error("fetchImpl was not called");
      return last;
    },
  };
}

function findTool(name: string): GeneratedTool {
  const tool = generatedTools.find((t) => t.name === name);
  if (!tool) throw new Error(`generated tool not found: ${name}`);
  return tool;
}

const baseConfig = {
  baseUrl: "https://task-store.example.com",
  token: "test-token",
};

// ─── GET with query params ───────────────────────────────────────────────

describe("callTool — tasks_list (GET, query params)", () => {
  it("GETs /tasks with query params and returns the task-store response body", async () => {
    const { fetchImpl, lastRequest } = cassetteFetch("tasks_list_success");
    const result = await callTool(
      findTool("tasks_list"),
      { status: "pending", limit: "10" },
      { ...baseConfig, fetchImpl },
    );

    const req = lastRequest();
    expect(req.method).toBe("GET");
    const url = new URL(req.url);
    expect(url.pathname).toBe("/tasks");
    expect(url.searchParams.get("status")).toBe("pending");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(req.body).toBeUndefined();

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(2);
    expect(parsed.tasks).toHaveLength(2);
  });
});

// ─── GET with path param ─────────────────────────────────────────────────

describe("callTool — tasks_get (GET, path param)", () => {
  it("substitutes the id path param and returns the task", async () => {
    const { fetchImpl, lastRequest } = cassetteFetch("tasks_get_success");
    const result = await callTool(
      findTool("tasks_get"),
      { id: "clx1234567890" },
      { ...baseConfig, fetchImpl },
    );

    expect(lastRequest().url).toBe(
      "https://task-store.example.com/tasks/clx1234567890",
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe("clx1234567890");
    expect(parsed.title).toBe("Implement feature X");
  });

  it("surfaces a plain-text 404 body as an error result", async () => {
    const { fetchImpl } = cassetteFetch("tasks_get_404");
    const result = await callTool(
      findTool("tasks_get"),
      { id: "missing-id" },
      { ...baseConfig, fetchImpl },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("404");
    expect(result.content[0].text).toContain("Task not found");
  });
});

// ─── POST with path param + object body ──────────────────────────────────

describe("callTool — tasks_claim (POST, path param + object body)", () => {
  it("sends the object body with the bearer token and returns the claimed task", async () => {
    const { fetchImpl, lastRequest } = cassetteFetch("tasks_claim_success");
    const result = await callTool(
      findTool("tasks_claim"),
      { id: "clx1234567890", claimedBy: "agent-42" },
      { ...baseConfig, fetchImpl },
    );

    const req = lastRequest();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(
      "https://task-store.example.com/tasks/clx1234567890/claim",
    );
    expect(req.headers.get("authorization")).toBe("Bearer test-token");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(req.body ?? "")).toEqual({ claimedBy: "agent-42" });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("in_progress");
    expect(parsed.claimedBy).toBe("agent-42");
  });
});

// ─── POST with array body ─────────────────────────────────────────────────

describe("callTool — tasks_bulk (POST, array body)", () => {
  it("sends args.items directly as a JSON array body", async () => {
    const { fetchImpl, lastRequest } = cassetteFetch("tasks_bulk_success");
    const items = [
      { title: "Task A", status: "pending" },
      { title: "Task B", status: "pending" },
    ];
    const result = await callTool(
      findTool("tasks_bulk"),
      { items },
      { ...baseConfig, fetchImpl },
    );

    const req = lastRequest();
    expect(req.url).toBe("https://task-store.example.com/tasks/bulk");
    expect(JSON.parse(req.body ?? "")).toEqual(items);

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
  });
});

// ─── DELETE with no body ──────────────────────────────────────────────────

describe("callTool — tasks_delete (DELETE, no body)", () => {
  it("sends no body and passes through an empty success response", async () => {
    const { fetchImpl, lastRequest } = cassetteFetch("tasks_delete_success");
    const result = await callTool(
      findTool("tasks_delete"),
      { id: "clx1234567890" },
      { ...baseConfig, fetchImpl },
    );

    const req = lastRequest();
    expect(req.method).toBe("DELETE");
    expect(req.body).toBeUndefined();
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("");
  });
});

// ─── Network failure ───────────────────────────────────────────────────────

describe("callTool — network failure", () => {
  it("wraps a rejected fetch in an error result instead of throwing", async () => {
    const failingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await callTool(
      findTool("tasks_get"),
      { id: "clx1234567890" },
      { ...baseConfig, fetchImpl: failingFetch },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("tasks_get");
    expect(result.content[0].text).toContain("ECONNREFUSED");
  });
});
