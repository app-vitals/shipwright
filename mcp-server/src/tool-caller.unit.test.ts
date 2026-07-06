import { describe, expect, it } from "bun:test";
import { callTool, configFromEnv } from "./tool-caller.ts";
import type { GeneratedTool } from "./generated-tools.ts";

const claimTool: GeneratedTool = {
  name: "tasks_claim",
  description: "Atomically claim a task",
  inputSchema: {
    type: "object",
    properties: {},
    required: ["id"],
  },
  method: "POST",
  pathTemplate: "/tasks/{id}/claim",
  queryParams: [],
  pathParams: ["id"],
  hasBody: true,
};

const listTool: GeneratedTool = {
  name: "tasks_list",
  description: "List tasks",
  inputSchema: { type: "object", properties: {}, required: [] },
  method: "GET",
  pathTemplate: "/tasks",
  queryParams: ["status", "limit"],
  pathParams: [],
  hasBody: false,
};

const bulkTool: GeneratedTool = {
  name: "tasks_bulk",
  description: "Bulk insert tasks",
  inputSchema: {
    type: "object",
    properties: {
      items: { type: "array", description: "Array of items to submit as the request body." },
    },
    required: ["items"],
    additionalProperties: false,
  },
  method: "POST",
  pathTemplate: "/tasks/bulk",
  queryParams: [],
  pathParams: [],
  hasBody: true,
  hasArrayBody: true,
};

/** Build an injected fetch double that records the request and returns a JSON body. */
function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const config = {
  baseUrl: "https://tasks.example.com",
  token: "secret-token",
};

describe("callTool", () => {
  it("substitutes path params and sends a bearer token", async () => {
    const { fn, calls } = fakeFetch({ id: "abc", status: "in_progress" });
    const result = await callTool(
      claimTool,
      { id: "abc", claimedBy: "agent-1" },
      {
        ...config,
        fetchImpl: fn,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://tasks.example.com/tasks/abc/claim");
    expect(calls[0].init?.method).toBe("POST");
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-token");
    expect(calls[0].init?.body).toBe(JSON.stringify({ claimedBy: "agent-1" }));

    expect(result.isError).toBeFalsy();
    expect(result.content[0].type).toBe("text");
  });

  it("appends query params and omits a body for GET", async () => {
    const { fn, calls } = fakeFetch({ tasks: [], total: 0 });
    await callTool(
      listTool,
      { status: "pending", limit: "10" },
      {
        ...config,
        fetchImpl: fn,
      },
    );

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/tasks");
    expect(url.searchParams.get("status")).toBe("pending");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(calls[0].init?.body).toBeUndefined();
  });

  it("marks non-2xx responses as errors", async () => {
    const { fn } = fakeFetch({ error: "not found" }, 404);
    const result = await callTool(
      claimTool,
      { id: "missing" },
      {
        ...config,
        fetchImpl: fn,
      },
    );
    expect(result.isError).toBe(true);
  });

  it("sends array body directly for hasArrayBody tools", async () => {
    const { fn, calls } = fakeFetch([{ id: "t1" }, { id: "t2" }]);
    const tasks = [{ title: "Task A", status: "pending" }, { title: "Task B", status: "pending" }];
    const result = await callTool(
      bulkTool,
      { items: tasks },
      { ...config, fetchImpl: fn },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://tasks.example.com/tasks/bulk");
    expect(calls[0].init?.method).toBe("POST");
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(calls[0].init?.body).toBe(JSON.stringify(tasks));
    expect(result.isError).toBeFalsy();
  });

  it("returns an error for hasArrayBody tools when items is not an array", async () => {
    const { fn } = fakeFetch({});
    const result = await callTool(
      bulkTool,
      { items: "not-an-array" },
      { ...config, fetchImpl: fn },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("array");
  });
});

describe("configFromEnv", () => {
  it("throws when SHIPWRIGHT_TASK_STORE_URL is missing", () => {
    expect(() =>
      configFromEnv({ SHIPWRIGHT_TASK_STORE_TOKEN: "tok" }),
    ).toThrow("SHIPWRIGHT_TASK_STORE_URL");
  });

  it("throws when SHIPWRIGHT_TASK_STORE_TOKEN is missing", () => {
    expect(() =>
      configFromEnv({ SHIPWRIGHT_TASK_STORE_URL: "https://example.com" }),
    ).toThrow("SHIPWRIGHT_TASK_STORE_TOKEN");
  });

  it("returns config when both vars are set", () => {
    const cfg = configFromEnv({
      SHIPWRIGHT_TASK_STORE_URL: "https://example.com",
      SHIPWRIGHT_TASK_STORE_TOKEN: "tok",
    });
    expect(cfg.baseUrl).toBe("https://example.com");
    expect(cfg.token).toBe("tok");
  });
});
