/**
 * agent/src/test-helpers/mock-deps.ts
 *
 * Shared in-memory ComposedAppDeps double for smoke tests.
 * No real DB, no network — every service is a deterministic in-memory stub.
 */

import type { ComposedAppDeps } from "../run-agent.ts";

export const TEST_SESSION_SECRET = "test-admin-session-secret-32-bytes!";
export const TEST_INTERNAL_API_KEY = "test-internal-api-key";
export const TEST_AGENT_ID = "agent-test-123";

export function makeMockDeps(): ComposedAppDeps {
  const mockAgent = {
    id: TEST_AGENT_ID,
    name: "Test Agent",
    slackId: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
  };

  return {
    prisma: {
      agent: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === TEST_AGENT_ID ? mockAgent : null,
        findMany: async () => [mockAgent],
        create: async () => mockAgent,
      },
      agentPlugin: {
        findMany: async () => [],
      },
    } as never,
    agentEnvService: {
      getConfigBundle: async (id: string) =>
        id === TEST_AGENT_ID
          ? { agentId: id, env: { FOO: "bar" }, allowedTools: ["Read"] }
          : null,
      getByAgentId: async () => ({ FOO: "bar" }),
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
      reconcileSystemCrons: async () => ({
        created: 0,
        updated: 0,
        deleted: 0,
      }),
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
    internalApiKey: TEST_INTERNAL_API_KEY,
    sessionSecret: TEST_SESSION_SECRET,
    googleClientId: "test-google-client-id",
    googleClientSecret: "test-google-client-secret",
    adminAllowedEmails: ["admin@example.com"],
    googleClient: {
      exchangeCode: async () => ({
        accessToken: "test-access-token",
        expiresIn: 3600,
      }),
      getUserInfo: async () => ({
        sub: "google-sub-123",
        email: "admin@example.com",
        name: "Admin User",
      }),
    },
    slackClient: {
      createAppManifest: async () => ({
        appId: "A123",
        oauthRedirectUrl: "https://slack.com/oauth",
      }),
    },
    appBaseUrl: "http://localhost:3000",
  };
}
