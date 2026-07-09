/**
 * task-store/src/auth.smoke.test.ts
 *
 * Smoke tests for the bearer auth middleware. Tests run in-process via a
 * minimal Hono app — no real HTTP socket, no real DB.
 *
 * Covers:
 *   1. Base 401 paths: missing Authorization header, malformed non-"Bearer "
 *      header, and an invalid/unknown token
 *   2. Scope resolver integration:
 *      a. When resolver returns repos, c.get('repos') is populated for agent tokens
 *      b. No scope resolver (URL not set path) → repos defaults to []
 *      c. Scope resolver throws → repos defaults to [] (no crash)
 *      d. Admin token (agentId null) → repos = null (unrestricted), resolver not called
 *   3. Shared Caller (AOB-3.3):
 *      a. Admin token → caller = {name: 'admin', scope: '*'}
 *      b. Agent token → caller = {name: agentId, scope: agentId}
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { Caller } from "@shipwright/lib/request-context";
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
      caller: c.get("caller"),
    });
  });
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("bearer auth middleware — base 401 paths", () => {
  it("returns 401 with WWW-Authenticate: Bearer when the Authorization header is absent", async () => {
    const app = makeAuthApp(fakeAdminTokenService());
    const res = await app.request("/whoami");

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 when the Authorization header is present but not a Bearer scheme", async () => {
    const app = makeAuthApp(fakeAdminTokenService());
    const res = await app.request("/whoami", {
      headers: { Authorization: `Basic ${btoa("user:pass")}` },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("returns 401 when the Authorization header is malformed (missing 'Bearer ' prefix)", async () => {
    const app = makeAuthApp(fakeAdminTokenService());
    const res = await app.request("/whoami", {
      headers: { Authorization: ADMIN_TOKEN },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("returns 401 with invalid_token error when the token does not validate", async () => {
    const app = makeAuthApp(fakeAdminTokenService());
    const res = await app.request("/whoami", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer error="invalid_token"',
    );
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("accepts a valid token and sets tokenId/agentId on the context", async () => {
    const app = makeAuthApp(fakeAdminTokenService());
    const res = await app.request("/whoami", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokenId: string; agentId: null };
    expect(body.tokenId).toBe("tok-admin");
    expect(body.agentId).toBeNull();
  });
});

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

describe("bearer auth middleware — shared Caller", () => {
  it("sets caller = {name: 'admin', scope: '*'} for admin tokens", async () => {
    const app = makeAuthApp(fakeAdminTokenService());
    const res = await app.request("/whoami", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { caller: Caller };
    expect(body.caller).toEqual({ name: "admin", scope: "*" });
  });

  it("sets caller = {name: agentId, scope: agentId} for agent tokens", async () => {
    const app = makeAuthApp(fakeAgentTokenService());
    const res = await app.request("/whoami", {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { caller: Caller };
    expect(body.caller).toEqual({ name: AGENT_ID, scope: AGENT_ID });
  });
});
