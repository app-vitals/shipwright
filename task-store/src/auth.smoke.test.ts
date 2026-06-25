/**
 * task-store/src/auth.smoke.test.ts
 *
 * Smoke tests for the bearer auth middleware's scope resolver integration.
 * Tests run in-process via a minimal Hono app — no real HTTP socket, no real DB.
 *
 * Covers:
 *   1. When resolver returns repos, c.get('repos') is populated for agent tokens
 *   2. No scope resolver (URL not set path) → repos defaults to []
 *   3. Scope resolver throws → repos defaults to [] (no crash)
 *   4. Admin token (agentId null) → repos = null (unrestricted), resolver not called
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createBearerAuthMiddleware } from "./auth.ts";
import type { TaskStoreAuthEnv } from "./auth.ts";
import type { TokenServiceLike } from "./token-service.ts";

// ─── Fakes ────────────────────────────────────────────────────────────────────

const ADMIN_TOKEN = "admin-token";
const AGENT_TOKEN = "agent-token";
const AGENT_ID = "agent-42";

function fakeAdminTokenService(): Pick<TokenServiceLike, "validate"> {
  return {
    async validate(raw: string) {
      return raw === ADMIN_TOKEN ? { id: "tok-admin", agentId: null } : null;
    },
  };
}

function fakeAgentTokenService(): Pick<TokenServiceLike, "validate"> {
  return {
    async validate(raw: string) {
      return raw === AGENT_TOKEN
        ? { id: "tok-agent", agentId: AGENT_ID }
        : null;
    },
  };
}

/** Build a minimal Hono app that mounts the bearer auth middleware and exposes
 *  the resolved `repos` on GET /whoami for inspection. */
function makeAuthApp(
  tokenService: Pick<TokenServiceLike, "validate">,
  scopeResolver?: (agentId: string) => Promise<string[]>,
) {
  const app = new Hono<TaskStoreAuthEnv>();
  app.use("*", createBearerAuthMiddleware({ tokenService, scopeResolver }));
  app.get("/whoami", (c) => {
    return c.json({
      tokenId: c.get("tokenId"),
      agentId: c.get("agentId"),
      repos: c.get("repos"),
    });
  });
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("bearer auth middleware — scope resolver", () => {
  it("populates repos from scope resolver for agent tokens", async () => {
    const resolver = async (_agentId: string) => ["org/repo-a", "org/repo-b"];

    const app = makeAuthApp(fakeAgentTokenService(), resolver);
    const res = await app.request("/whoami", {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: string[] };
    expect(body.repos).toEqual(["org/repo-a", "org/repo-b"]);
  });

  it("defaults repos to [] when no scope resolver is provided", async () => {
    // No scopeResolver passed — simulates URL not set.
    const app = makeAuthApp(fakeAgentTokenService());
    const res = await app.request("/whoami", {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: string[] };
    expect(body.repos).toEqual([]);
  });

  it("defaults repos to [] when scope resolver throws (no crash)", async () => {
    const resolver = async (_agentId: string): Promise<string[]> => {
      throw new Error("agents service unavailable");
    };

    const app = makeAuthApp(fakeAgentTokenService(), resolver);
    const res = await app.request("/whoami", {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: string[] };
    expect(body.repos).toEqual([]);
  });

  it("admin tokens always get repos: null (unrestricted) and scope resolver is not called", async () => {
    let resolverCalled = false;
    const resolver = async (_agentId: string) => {
      resolverCalled = true;
      return ["org/should-not-appear"];
    };

    const app = makeAuthApp(fakeAdminTokenService(), resolver);
    const res = await app.request("/whoami", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repos: string[] | null;
      agentId: string | null;
    };
    expect(body.agentId).toBeNull();
    expect(body.repos).toBeNull();
    expect(resolverCalled).toBe(false);
  });
});
