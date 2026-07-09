/**
 * admin/src/agents-api.sentry.smoke.test.ts
 *
 * Smoke tests for the onError hook's Sentry wiring (SEN-1.3).
 *
 * Asserts:
 *   - an unhandled (non-ApiError) error triggers sentryClient.captureException
 *     when a fake sentryClient is injected via AdminDeps
 *   - 4xx ApiError instances (expected, typed client errors mapped to real
 *     HTTP status codes) do NOT trigger captureException
 *   - 5xx ApiError instances (server faults, e.g. BadGatewayError) DO trigger
 *     captureException
 *   - with no sentryClient dep (undefined — Sentry not initialized), onError
 *     does not throw and behaves exactly as before
 */

import { describe, expect, it } from "bun:test";
import type { ErrorCapturingClient } from "@shipwright/lib/sentry";
import type { AgentEnvService } from "./agent-envs.ts";
import type { AgentProvisioner, ProvisionResult } from "./agent-provisioner.ts";
import { createAdminApp } from "./agents-api.ts";
import type { AdminDeps } from "./agents-api.ts";
import { BadGatewayError, NotFoundError } from "./errors.ts";

const AGENT_ID = "agent-test-123";
const VALID_BEARER_TOKEN = "valid-bearer-token-value";
const SESSION_SECRET = "test-admin-session-secret-32-bytes!";

/** No-op AgentProvisioner double — provisioning is not exercised by these tests. */
class NoopProvisioner implements AgentProvisioner {
  async provision(): Promise<ProvisionResult> {
    return {
      resourceName: AGENT_ID,
      secretName: `${AGENT_ID}-token`,
      deploymentName: AGENT_ID,
    };
  }
  async deprovision(): Promise<void> {}
  async reconcile() {
    return { recreated: [], updated: [], orphans: [], failed: [] };
  }
}

function fakeErrorCapturingClient(): ErrorCapturingClient & {
  capturedErrors: unknown[];
} {
  const capturedErrors: unknown[] = [];
  return {
    captureException: (err: unknown) => {
      capturedErrors.push(err);
    },
    capturedErrors,
  };
}

/** An AgentEnvService whose getByAgentId throws an unhandled, non-ApiError error. */
function throwingAgentEnvService(): AdminDeps["agentEnvService"] {
  return new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error("boom: unexpected failure");
        };
      },
    },
  ) as AgentEnvService;
}

/** An AgentEnvService whose getByAgentId throws a typed ApiError (NotFoundError). */
function apiErrorAgentEnvService(): AdminDeps["agentEnvService"] {
  return new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new NotFoundError("agent not found");
        };
      },
    },
  ) as AgentEnvService;
}

/** An AgentEnvService whose getByAgentId throws a 5xx ApiError (BadGatewayError). */
function serverFaultAgentEnvService(): AdminDeps["agentEnvService"] {
  return new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new BadGatewayError("upstream Kubernetes API failed");
        };
      },
    },
  ) as AgentEnvService;
}

function makeBaseDeps(
  agentEnvService: AdminDeps["agentEnvService"],
): Omit<AdminDeps, "sentryClient"> {
  return {
    agentEnvService,
    agentCronJobService: {
      list: async () => [],
      listWithRunSummary: async () => [],
      create: async () => ({}) as never,
      update: async () => ({}) as never,
      delete: async () => {},
      get: async () => ({}) as never,
      setEnabled: async () => ({}) as never,
      updatePreCheck: async () => ({}) as never,
      reconcileSystemCrons: async () => ({
        created: 0,
        updated: 0,
        deleted: 0,
      }),
    },
    agentCronRunService: {
      create: async () => ({}) as never,
      list: async () => ({ items: [], total: 0, limit: 20, offset: 0 }),
      patch: async () => ({}) as never,
    },
    agentCronRunStatsService: {
      query: async () => ({
        totals: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheCreation: 0,
          total: 0,
        },
        byAgent: [],
        byCron: [],
        byModel: [],
        daily: [],
        byCronModel: [],
        byPhase: [],
      }),
    },
    agentToolService: {
      list: async () => [],
      add: async () => ({}) as never,
      toggle: async () => ({}) as never,
      remove: async () => {},
    },
    agentTokenService: {
      create: async () => ({}) as never,
      listForAgent: async () => [],
      revoke: async () => ({}) as never,
      validate: async (raw: string) =>
        raw === VALID_BEARER_TOKEN ? { agentId: AGENT_ID } : null,
    },
    agentPluginService: {
      list: async () => [],
      add: async () => ({}) as never,
      remove: async () => {},
      removeByName: async () => {},
    },
    agentChatTokenService: {
      upsertDailyByModel: async () => ({}) as never,
      queryStats: async () => ({
        totals: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheCreation: 0,
          total: 0,
        },
        byAgent: [],
        byModel: [],
        daily: [],
      }),
    },
    prisma: {
      agent: {} as never,
    } as AdminDeps["prisma"],
    provisioner: new NoopProvisioner(),
    sessionSecret: SESSION_SECRET,
  };
}

describe("onError — Sentry capture wiring", () => {
  it("calls sentryClient.captureException for an unhandled (non-ApiError) error", async () => {
    const sentryClient = fakeErrorCapturingClient();
    const app = createAdminApp({
      ...makeBaseDeps(throwingAgentEnvService()),
      sentryClient,
    });

    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
      headers: { Authorization: `Bearer ${VALID_BEARER_TOKEN}` },
    });

    expect(res.status).toBe(500);
    expect(sentryClient.capturedErrors.length).toBe(1);
    expect((sentryClient.capturedErrors[0] as Error).message).toBe(
      "boom: unexpected failure",
    );
  });

  it("does NOT call sentryClient.captureException for a 4xx ApiError", async () => {
    const sentryClient = fakeErrorCapturingClient();
    const app = createAdminApp({
      ...makeBaseDeps(apiErrorAgentEnvService()),
      sentryClient,
    });

    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
      headers: { Authorization: `Bearer ${VALID_BEARER_TOKEN}` },
    });

    expect(res.status).toBe(404);
    expect(sentryClient.capturedErrors.length).toBe(0);
  });

  it("calls sentryClient.captureException for a 5xx ApiError (server fault)", async () => {
    const sentryClient = fakeErrorCapturingClient();
    const app = createAdminApp({
      ...makeBaseDeps(serverFaultAgentEnvService()),
      sentryClient,
    });

    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
      headers: { Authorization: `Bearer ${VALID_BEARER_TOKEN}` },
    });

    expect(res.status).toBe(502);
    expect(sentryClient.capturedErrors.length).toBe(1);
    expect((sentryClient.capturedErrors[0] as Error).message).toBe(
      "upstream Kubernetes API failed",
    );
  });

  it("does not throw when sentryClient is undefined (Sentry not initialized)", async () => {
    const app = createAdminApp(makeBaseDeps(throwingAgentEnvService()));

    const res = await app.request(`/agents/${AGENT_ID}/envs`, {
      headers: { Authorization: `Bearer ${VALID_BEARER_TOKEN}` },
    });

    expect(res.status).toBe(500);
  });
});
