/**
 * task-store/src/auth.unit.test.ts
 *
 * Unit tests for the `scopeDegraded` signal set by createBearerAuthMiddleware.
 *
 * scopeDegraded distinguishes "the scope resolver call itself failed" (network
 * error, timeout, non-2xx, malformed JSON — surfaced as a rejection from the
 * injected scopeResolver) from "the resolver succeeded and legitimately
 * returned []" (an agent with no repos configured). Both cases leave
 * `repos: []` unchanged — this is a purely additive observability signal, no
 * new I/O boundary, so it lives at the unit layer (a minimal in-process Hono
 * app is only used because that's the middleware's actual contract surface;
 * there is no real socket/dependency involved).
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createBearerAuthMiddleware } from "./auth.ts";
import type { TaskStoreAuthEnv } from "./auth.ts";
import type { TokenServiceLike } from "./token-service.ts";

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
 *  the resolved `scopeDegraded` (and `repos`) on GET /whoami for inspection. */
function makeAuthApp(
  tokenService: Pick<TokenServiceLike, "validate">,
  scopeResolver?: (agentId: string) => Promise<string[]>,
) {
  const app = new Hono<TaskStoreAuthEnv>();
  app.use("*", createBearerAuthMiddleware({ tokenService, scopeResolver }));
  app.get("/whoami", (c) => {
    return c.json({
      agentId: c.get("agentId"),
      repos: c.get("repos"),
      scopeDegraded: c.get("scopeDegraded"),
    });
  });
  return app;
}

describe("bearer auth middleware — scopeDegraded", () => {
  it("sets scopeDegraded: true when the scope resolver throws/rejects", async () => {
    const resolver = async (_agentId: string): Promise<string[]> => {
      throw new Error("agents service unavailable");
    };

    const app = makeAuthApp(fakeAgentTokenService(), resolver);
    const res = await app.request("/whoami", {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repos: string[];
      scopeDegraded: boolean;
    };
    expect(body.repos).toEqual([]);
    expect(body.scopeDegraded).toBe(true);
  });

  it("sets scopeDegraded: false when the resolver resolves to a legitimate empty array", async () => {
    const resolver = async (_agentId: string): Promise<string[]> => [];

    const app = makeAuthApp(fakeAgentTokenService(), resolver);
    const res = await app.request("/whoami", {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repos: string[];
      scopeDegraded: boolean;
    };
    expect(body.repos).toEqual([]);
    expect(body.scopeDegraded).toBe(false);
  });

  it("always sets scopeDegraded: false for admin tokens (resolver not called)", async () => {
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
      agentId: string | null;
      repos: string[] | null;
      scopeDegraded: boolean;
    };
    expect(body.agentId).toBeNull();
    expect(body.repos).toBeNull();
    expect(body.scopeDegraded).toBe(false);
    expect(resolverCalled).toBe(false);
  });
});
