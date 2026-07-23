/**
 * scripts/hitl.unit.test.ts
 * Unit tests for the pure logic in scripts/hitl.ts — command selection,
 * task-store response parsing, workspace-provisioning idempotency planning,
 * and the env built for the spawned Claude process. Everything with a real
 * I/O boundary (fs, fetch, Bun.spawn) is exercised through injected doubles
 * or by construction, never mocked globally.
 */

import { describe, expect, test } from "bun:test";
import {
  buildClaudeSpawnEnv,
  buildTaskCommand,
  computeProvisionPlan,
  ensureHitlAgent,
  parseHitlAuthors,
  parseHitlRepos,
  parseTasksResponse,
  type Task,
} from "./hitl.ts";

/**
 * Injected fetch double for ensureHitlAgent()'s admin-API calls. Each entry
 * matches on {method, path suffix} and returns a canned Response — no real
 * network calls, per the repo's isolation contract.
 */
type Route = {
  method: string;
  match: (url: string) => boolean;
  respond: () => Response;
};

function makeFetchDouble(routes: Route[]): typeof fetch {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fetchDouble = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, body: init?.body as string | undefined });
    const route = routes.find(
      (r) => r.method === method && r.match(url),
    );
    if (!route) {
      throw new Error(`no route matched ${method} ${url}`);
    }
    return route.respond();
  }) as typeof fetch;
  (fetchDouble as unknown as { calls: typeof calls }).calls = calls;
  return fetchDouble;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("buildTaskCommand", () => {
  test("routes hitl tasks to /shipwright:hitl", () => {
    expect(buildTaskCommand({ id: "HTC-1.1", hitl: true })).toBe(
      "/shipwright:hitl HTC-1.1",
    );
  });

  test("routes non-hitl tasks to /shipwright:dev-task", () => {
    expect(buildTaskCommand({ id: "PV-1.2", hitl: false })).toBe(
      "/shipwright:dev-task PV-1.2",
    );
  });

  test("treats a missing hitl field as non-hitl", () => {
    expect(buildTaskCommand({ id: "PV-1.2" })).toBe(
      "/shipwright:dev-task PV-1.2",
    );
  });
});

describe("parseTasksResponse", () => {
  test("returns the tasks array when present", () => {
    const tasks: Task[] = [
      { id: "PV-1.2", title: "Do the thing", status: "pending" },
    ];
    expect(parseTasksResponse({ tasks })).toEqual(tasks);
  });

  test("returns [] when tasks is missing", () => {
    expect(parseTasksResponse({})).toEqual([]);
  });

  test("returns [] when tasks is not an array", () => {
    expect(parseTasksResponse({ tasks: "nope" })).toEqual([]);
  });

  test("returns [] for null", () => {
    expect(parseTasksResponse(null)).toEqual([]);
  });

  test("returns [] for a non-object", () => {
    expect(parseTasksResponse("not json")).toEqual([]);
  });
});

describe("computeProvisionPlan", () => {
  test("reports all dirs missing and CLAUDE.md needed on a fresh workspace", () => {
    const plan = computeProvisionPlan(
      ["/ws", "/ws/repos", "/ws/worktrees"],
      "/ws/CLAUDE.md",
      () => false,
    );
    expect(plan.missingDirs).toEqual(["/ws", "/ws/repos", "/ws/worktrees"]);
    expect(plan.needsClaudeMd).toBe(true);
  });

  test("reports nothing missing when everything already exists", () => {
    const plan = computeProvisionPlan(
      ["/ws", "/ws/repos"],
      "/ws/CLAUDE.md",
      () => true,
    );
    expect(plan.missingDirs).toEqual([]);
    expect(plan.needsClaudeMd).toBe(false);
  });

  test("reports only the dirs that don't yet exist", () => {
    const existing = new Set(["/ws"]);
    const plan = computeProvisionPlan(
      ["/ws", "/ws/repos", "/ws/worktrees"],
      "/ws/CLAUDE.md",
      (path) => existing.has(path),
    );
    expect(plan.missingDirs).toEqual(["/ws/repos", "/ws/worktrees"]);
    expect(plan.needsClaudeMd).toBe(true);
  });

  test("CLAUDE.md need is independent of dir existence", () => {
    const plan = computeProvisionPlan(["/ws"], "/ws/CLAUDE.md", (path) =>
      path === "/ws",
    );
    expect(plan.missingDirs).toEqual([]);
    expect(plan.needsClaudeMd).toBe(true);
  });
});

describe("buildClaudeSpawnEnv", () => {
  test("overlays task-store and workspace dir vars onto the base env", () => {
    const base = { PATH: "/usr/bin", SOME_OTHER_VAR: "keep-me" };
    const env = buildClaudeSpawnEnv(base);

    expect(env.PATH).toBe("/usr/bin");
    expect(env.SOME_OTHER_VAR).toBe("keep-me");
    expect(env.SHIPWRIGHT_TASK_STORE_URL).toMatch(/^http:\/\//);
    expect(typeof env.SHIPWRIGHT_TASK_STORE_TOKEN).toBe("string");
    expect(typeof env.SHIPWRIGHT_REPO_DIR).toBe("string");
    expect(typeof env.SHIPWRIGHT_WORKTREE_DIR).toBe("string");
  });

  test("does not mutate the base env object", () => {
    const base = { PATH: "/usr/bin" };
    buildClaudeSpawnEnv(base);
    expect(Object.keys(base)).toEqual(["PATH"]);
  });
});

describe("parseHitlRepos", () => {
  test("returns [] for undefined", () => {
    expect(parseHitlRepos(undefined)).toEqual([]);
  });

  test("returns [] for an empty string", () => {
    expect(parseHitlRepos("")).toEqual([]);
  });

  test("splits a comma-separated list and trims whitespace", () => {
    expect(parseHitlRepos("org/a, org/b ,org/c")).toEqual([
      "org/a",
      "org/b",
      "org/c",
    ]);
  });

  test("drops empty entries from stray commas", () => {
    expect(parseHitlRepos("org/a,,org/b,")).toEqual(["org/a", "org/b"]);
  });

  test("returns a single-entry list for a value with no commas", () => {
    expect(parseHitlRepos("org/solo")).toEqual(["org/solo"]);
  });
});

describe("parseHitlAuthors", () => {
  test("returns [] for undefined", () => {
    expect(parseHitlAuthors(undefined)).toEqual([]);
  });

  test("returns [] for an empty string", () => {
    expect(parseHitlAuthors("")).toEqual([]);
  });

  test("splits a comma-separated list, trims whitespace, and drops empty entries", () => {
    expect(parseHitlAuthors("danmcaulay, dave ,,other-user,")).toEqual([
      "danmcaulay",
      "dave",
      "other-user",
    ]);
  });

  test("returns a single-entry list for a value with no commas", () => {
    expect(parseHitlAuthors("danmcaulay")).toEqual(["danmcaulay"]);
  });
});

describe("ensureHitlAgent", () => {
  test("create path: no existing agent — creates, then PATCHes repos when non-empty", async () => {
    const fetchDouble = makeFetchDouble([
      {
        method: "GET",
        match: (url) => url.endsWith("/agents"),
        respond: () => json([]),
      },
      {
        method: "POST",
        match: (url) => url.endsWith("/agents"),
        respond: () => json({ id: "agent-1", name: "hitl", repos: [] }, 201),
      },
      {
        method: "PATCH",
        match: (url) => url.endsWith("/agents/agent-1"),
        respond: () =>
          json({ id: "agent-1", name: "hitl", repos: ["org/repo"] }),
      },
    ]);

    const id = await ensureHitlAgent(fetchDouble, ["org/repo"]);

    expect(id).toBe("agent-1");
    const calls = (fetchDouble as unknown as { calls: Array<{ method: string; url: string; body?: string }> }).calls;
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "PATCH"]);
    expect(JSON.parse(calls[2].body ?? "{}")).toEqual({ repos: ["org/repo"] });
  });

  test("create path: no existing agent, HITL_REPOS empty — creates, skips PATCH", async () => {
    const fetchDouble = makeFetchDouble([
      {
        method: "GET",
        match: (url) => url.endsWith("/agents"),
        respond: () => json([]),
      },
      {
        method: "POST",
        match: (url) => url.endsWith("/agents"),
        respond: () => json({ id: "agent-1", name: "hitl", repos: [] }, 201),
      },
    ]);

    const id = await ensureHitlAgent(fetchDouble, []);

    expect(id).toBe("agent-1");
    const calls = (fetchDouble as unknown as { calls: Array<{ method: string }> }).calls;
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  test("existing-agent-match path: repos already match — no PATCH issued", async () => {
    const fetchDouble = makeFetchDouble([
      {
        method: "GET",
        match: (url) => url.endsWith("/agents"),
        respond: () =>
          json([{ id: "agent-1", name: "hitl", selfHosted: true }]),
      },
      {
        method: "GET",
        match: (url) => url.endsWith("/agents/agent-1"),
        respond: () =>
          json({ id: "agent-1", name: "hitl", repos: ["org/repo"] }),
      },
    ]);

    const id = await ensureHitlAgent(fetchDouble, ["org/repo"]);

    expect(id).toBe("agent-1");
    const calls = (fetchDouble as unknown as { calls: Array<{ method: string }> }).calls;
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });

  test("existing-agent-mismatch path: repos differ — fetches detail then PATCHes", async () => {
    const fetchDouble = makeFetchDouble([
      {
        method: "GET",
        match: (url) => url.endsWith("/agents"),
        respond: () =>
          json([{ id: "agent-1", name: "hitl", selfHosted: true }]),
      },
      {
        method: "GET",
        match: (url) => url.endsWith("/agents/agent-1"),
        respond: () =>
          json({ id: "agent-1", name: "hitl", repos: ["org/old"] }),
      },
      {
        method: "PATCH",
        match: (url) => url.endsWith("/agents/agent-1"),
        respond: () =>
          json({ id: "agent-1", name: "hitl", repos: ["org/new"] }),
      },
    ]);

    const id = await ensureHitlAgent(fetchDouble, ["org/new"]);

    expect(id).toBe("agent-1");
    const calls = (fetchDouble as unknown as { calls: Array<{ method: string; url: string; body?: string }> }).calls;
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(JSON.parse(calls[2].body ?? "{}")).toEqual({ repos: ["org/new"] });
  });

  test("failure path: GET /agents non-ok — returns null, no further calls", async () => {
    const fetchDouble = makeFetchDouble([
      {
        method: "GET",
        match: (url) => url.endsWith("/agents"),
        respond: () => json({ error: "forbidden" }, 403),
      },
    ]);

    const id = await ensureHitlAgent(fetchDouble, ["org/repo"]);

    expect(id).toBeNull();
    const calls = (fetchDouble as unknown as { calls: Array<{ method: string }> }).calls;
    expect(calls).toHaveLength(1);
  });

  test("failure path: POST /agents non-ok — returns null", async () => {
    const fetchDouble = makeFetchDouble([
      {
        method: "GET",
        match: (url) => url.endsWith("/agents"),
        respond: () => json([]),
      },
      {
        method: "POST",
        match: (url) => url.endsWith("/agents"),
        respond: () => json({ error: "boom" }, 500),
      },
    ]);

    const id = await ensureHitlAgent(fetchDouble, ["org/repo"]);

    expect(id).toBeNull();
  });

  test("failure path: PATCH non-ok on mismatch — still returns the existing agent id", async () => {
    const fetchDouble = makeFetchDouble([
      {
        method: "GET",
        match: (url) => url.endsWith("/agents"),
        respond: () =>
          json([{ id: "agent-1", name: "hitl", selfHosted: true }]),
      },
      {
        method: "GET",
        match: (url) => url.endsWith("/agents/agent-1"),
        respond: () =>
          json({ id: "agent-1", name: "hitl", repos: ["org/old"] }),
      },
      {
        method: "PATCH",
        match: (url) => url.endsWith("/agents/agent-1"),
        respond: () => json({ error: "boom" }, 500),
      },
    ]);

    const id = await ensureHitlAgent(fetchDouble, ["org/new"]);

    expect(id).toBe("agent-1");
  });

  test("failure path: GET /agents/:id detail fetch non-ok on existing agent — returns summary id", async () => {
    const fetchDouble = makeFetchDouble([
      {
        method: "GET",
        match: (url) => url.endsWith("/agents"),
        respond: () =>
          json([{ id: "agent-1", name: "hitl", selfHosted: true }]),
      },
      {
        method: "GET",
        match: (url) => url.endsWith("/agents/agent-1"),
        respond: () => json({ error: "boom" }, 500),
      },
    ]);

    const id = await ensureHitlAgent(fetchDouble, ["org/repo"]);

    expect(id).toBe("agent-1");
  });
});
