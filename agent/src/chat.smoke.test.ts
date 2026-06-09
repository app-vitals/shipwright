/**
 * agent/src/chat.smoke.test.ts — POST /chat, in-process app.request(), fake runner.
 */

import { describe, expect, it } from "bun:test";
import { createChatApp } from "./chat.ts";
import { createComposedApp } from "./run-agent.ts";
import type { ComposedAppDeps } from "./run-agent.ts";

// ─── Fake runner ──────────────────────────────────────────────────────────────

type FakeRunner = (
  message: string,
  sessionKey: string,
) => Promise<{ result: string; sessionId?: string }>;

function makeFakeRunner(): {
  runner: FakeRunner;
  calls: Array<{ message: string; sessionKey: string }>;
} {
  const calls: Array<{ message: string; sessionKey: string }> = [];
  const runner: FakeRunner = async (message, sessionKey) => {
    calls.push({ message, sessionKey });
    return { result: `reply:${message}`, sessionId: sessionKey };
  };
  return { runner, calls };
}

// ─── Minimal ComposedAppDeps double ───────────────────────────────────────────

function makeMockDeps(
  overrides: Partial<ComposedAppDeps> = {},
): ComposedAppDeps {
  const base: ComposedAppDeps = {
    prisma: {
      agent: {
        findUnique: async () => null,
        findMany: async () => [],
        create: async () => {
          throw new Error("not implemented");
        },
      },
      agentPlugin: {
        findMany: async () => [],
      },
    } as never,
    agentEnvService: {
      getConfigBundle: async () => null,
      getByAgentId: async () => ({}),
      upsert: async () => {},
      patch: async () => {},
      deleteKey: async () => {},
    },
    agentCronJobService: {
      list: async () => [],
      create: async () => {
        throw new Error("not implemented");
      },
      update: async () => {
        throw new Error("not implemented");
      },
      delete: async () => {},
      reconcileSystemCrons: async () => ({ created: 0, updated: 0, deleted: 0 }),
      get: async () => {
        throw new Error("not implemented");
      },
      setEnabled: async () => {
        throw new Error("not implemented");
      },
    },
    agentToolService: {
      list: async () => [],
      add: async () => {
        throw new Error("not implemented");
      },
      remove: async () => {},
      toggle: async () => {
        throw new Error("not implemented");
      },
    },
    agentTokenService: {
      create: async () => {
        throw new Error("not implemented");
      },
      listForAgent: async () => [],
      revoke: async () => null,
    },
    agentPluginService: {
      list: async () => [],
      add: async () => {
        throw new Error("not implemented");
      },
      remove: async () => {},
      removeByName: async () => {},
    },
    internalApiKey: "test-key",
    sessionSecret: "test-session-secret-32-bytes!!!",
    adminPassword: "test-password",
    slackClient: {
      createAppManifest: async () => ({
        appId: "A123",
        oauthRedirectUrl: "https://slack.com/oauth",
      }),
    },
    appBaseUrl: "http://localhost:3000",
  };
  return { ...base, ...overrides };
}

// ─── createChatApp standalone tests ──────────────────────────────────────────

describe("createChatApp — POST /chat", () => {
  it("returns {result, sessionId} from the injected runner", async () => {
    const { runner } = makeFakeRunner();
    const app = createChatApp({ runner });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string; sessionId: string };
    expect(body.result).toBe("reply:hello");
    expect(typeof body.sessionId).toBe("string");
    expect(body.sessionId.length).toBeGreaterThan(0);
  });

  it("passes the provided session back as sessionKey on the next call (continuity)", async () => {
    const { runner, calls } = makeFakeRunner();
    const app = createChatApp({ runner });

    // First call — no session provided
    const res1 = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "first" }),
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { result: string; sessionId: string };
    const sessionId = body1.sessionId;
    expect(typeof sessionId).toBe("string");

    // Second call — pass back the returned sessionId
    const res2 = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "second", session: sessionId }),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { result: string; sessionId: string };

    // The second call must use the same sessionKey as the first
    expect(calls[1].sessionKey).toBe(calls[0].sessionKey);
    // The sessionId returned should be stable
    expect(body2.sessionId).toBe(sessionId);
  });

  it("generates a new sessionKey when no session is provided", async () => {
    const { runner, calls } = makeFakeRunner();
    const app = createChatApp({ runner });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(calls[0].sessionKey).toBeTruthy();
  });

  it("returns 400 when message is missing", async () => {
    const { runner } = makeFakeRunner();
    const app = createChatApp({ runner });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ─── devChat flag via createComposedApp ───────────────────────────────────────

describe("createComposedApp — devChat:true mounts /chat", () => {
  it("POST /chat returns {result, sessionId} with devChat:true", async () => {
    const { runner } = makeFakeRunner();
    const app = createComposedApp({
      ...makeMockDeps(),
      devChat: true,
      runner,
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello from composed app" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string; sessionId: string };
    expect(body.result).toBe("reply:hello from composed app");
    expect(typeof body.sessionId).toBe("string");
  });
});

describe("createComposedApp — devChat:false (default) does NOT mount /chat", () => {
  it("POST /chat returns 404 when devChat is false", async () => {
    const { runner } = makeFakeRunner();
    const app = createComposedApp({
      ...makeMockDeps(),
      devChat: false,
      runner,
    });

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "should be gone" }),
    });

    expect(res.status).toBe(404);
  });

  it("POST /chat returns 404 when devChat is not set (default-deny)", async () => {
    const app = createComposedApp(makeMockDeps());

    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "should be gone" }),
    });

    expect(res.status).toBe(404);
  });
});
