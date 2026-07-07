/**
 * task-store/src/auth.integration.test.ts
 *
 * Integration tests for createScopeResolver — the factory that builds a scope
 * resolver calling the agents service over real HTTP.
 *
 * Strategy: spin up a real Bun.serve stub agents API, inject its URL via
 * `baseUrl`, and verify the resolver's behavior against real network calls —
 * no global.fetch overrides, no mock.module().
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createScopeResolver } from "./auth.ts";

// ─── Stub server ──────────────────────────────────────────────────────────────

interface StubState {
  /** Response body to return for the next request, or a function producing one. */
  responseBody: unknown;
  /** HTTP status to return. */
  status: number;
  /** When true, return a body that is not valid JSON. */
  malformedJson: boolean;
  /** Captured request headers/path from the last call. */
  lastPath: string | null;
  lastAuthHeader: string | null;
}

// biome-ignore lint/suspicious/noExplicitAny: Server type param varies by bun version
function startStubServer(port: number, state: StubState): ReturnType<typeof Bun.serve<any>> {
  return Bun.serve({
    port,
    fetch: async (req) => {
      const url = new URL(req.url);
      state.lastPath = url.pathname;
      state.lastAuthHeader = req.headers.get("Authorization");

      if (state.malformedJson) {
        return new Response("not json{{{", {
          status: state.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify(state.responseBody), {
        status: state.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createScopeResolver (integration)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: Server type param varies by bun version
  let server: ReturnType<typeof Bun.serve<any>>;
  let state: StubState;
  const PORT = 19962;
  const BASE_URL = `http://localhost:${PORT}`;
  const ADMIN_API_KEY = "test-admin-key";

  beforeEach(() => {
    state = {
      responseBody: { repos: ["org/repo-a", "org/repo-b"] },
      status: 200,
      malformedJson: false,
      lastPath: null,
      lastAuthHeader: null,
    };
    server = startStubServer(PORT, state);
  });

  afterEach(() => {
    server.stop(true);
  });

  it("returns the repos array on a successful response", async () => {
    const resolver = createScopeResolver(BASE_URL, ADMIN_API_KEY);
    const repos = await resolver("agent-42");

    expect(repos).toEqual(["org/repo-a", "org/repo-b"]);
    expect(state.lastPath).toBe("/agents/agent-42");
    expect(state.lastAuthHeader).toBe(`Bearer ${ADMIN_API_KEY}`);
  });

  it("normalizes a trailing slash on baseUrl", async () => {
    const resolver = createScopeResolver(`${BASE_URL}/`, ADMIN_API_KEY);
    await resolver("agent-77");
    expect(state.lastPath).toBe("/agents/agent-77");
  });

  it("filters out non-string entries from the repos array", async () => {
    state.responseBody = { repos: ["org/repo-a", 42, null, "org/repo-b", {}] };
    const resolver = createScopeResolver(BASE_URL, ADMIN_API_KEY);
    const repos = await resolver("agent-42");
    expect(repos).toEqual(["org/repo-a", "org/repo-b"]);
  });

  it("returns [] when the response is a non-ok status (e.g. 404)", async () => {
    state.status = 404;
    state.responseBody = { error: "not found" };
    const resolver = createScopeResolver(BASE_URL, ADMIN_API_KEY);
    const repos = await resolver("agent-missing");
    expect(repos).toEqual([]);
  });

  it("returns [] when the response is a non-ok status (500)", async () => {
    state.status = 500;
    state.responseBody = { error: "server error" };
    const resolver = createScopeResolver(BASE_URL, ADMIN_API_KEY);
    const repos = await resolver("agent-42");
    expect(repos).toEqual([]);
  });

  it("returns [] when the response body is malformed JSON", async () => {
    state.malformedJson = true;
    const resolver = createScopeResolver(BASE_URL, ADMIN_API_KEY);
    const repos = await resolver("agent-42");
    expect(repos).toEqual([]);
  });

  it("returns [] when the repos field is missing from the body", async () => {
    state.responseBody = { other: "data" };
    const resolver = createScopeResolver(BASE_URL, ADMIN_API_KEY);
    const repos = await resolver("agent-42");
    expect(repos).toEqual([]);
  });

  it("returns [] when the repos field is not an array", async () => {
    state.responseBody = { repos: "not-an-array" };
    const resolver = createScopeResolver(BASE_URL, ADMIN_API_KEY);
    const repos = await resolver("agent-42");
    expect(repos).toEqual([]);
  });

  it("returns [] when the body is an array instead of an object", async () => {
    state.responseBody = ["org/repo-a"];
    const resolver = createScopeResolver(BASE_URL, ADMIN_API_KEY);
    const repos = await resolver("agent-42");
    expect(repos).toEqual([]);
  });

  it("returns [] when the body is null", async () => {
    state.responseBody = null;
    const resolver = createScopeResolver(BASE_URL, ADMIN_API_KEY);
    const repos = await resolver("agent-42");
    expect(repos).toEqual([]);
  });

  it("returns [] when the network request throws (server unreachable)", async () => {
    // Point at a port with nothing listening — fetch will throw/reject.
    server.stop(true);
    const resolver = createScopeResolver(
      "http://localhost:19963",
      ADMIN_API_KEY,
    );
    const repos = await resolver("agent-42");
    expect(repos).toEqual([]);
  });
});
