/**
 * metrics/src/lib/test-helpers.ts
 * Test doubles for the metrics package.
 * NOT exported from index.ts — test-only.
 */

import type {
  AccountsClient,
  AgentRecord,
  UserRecord,
} from "./accounts-client.ts";
import type { Clock } from "./clock.ts";

// ─── FixedClock ───────────────────────────────────────────────────────────────

/**
 * Test double for the Clock interface.
 * Returns a frozen time that can be advanced deterministically via advance(ms).
 */
export function FixedClock(
  t: Date | string,
): Clock & { advance(ms: number): void } {
  const baseMs = typeof t === "string" ? new Date(t).getTime() : t.getTime();
  let offsetMs = 0;

  return {
    now(): Date {
      return new Date(baseMs + offsetMs);
    },
    advance(ms: number): void {
      offsetMs += ms;
    },
  };
}

// ─── makeAccountsClientMock ──────────────────────────────────────────────────

/**
 * Minimal AccountsClient stub for tests that need to control listUsers /
 * listAgents output but don't exercise any other accounts methods.
 *
 * When `listAgentsImpl` is omitted, `listAgents` derives agent records from
 * `listUsersImpl` (maps each user to `{ id, name }`). Pass an explicit
 * `listAgentsImpl` to override that default — e.g. to simulate a failure or
 * return a distinct set of agent records.
 */
export function makeAccountsClientMock(
  listUsersImpl: () => Promise<UserRecord[]>,
  listAgentsImpl?: () => Promise<AgentRecord[]>,
): AccountsClient {
  const notImplemented = async (): Promise<never> => {
    throw new Error("not implemented");
  };
  return {
    listUsers: listUsersImpl,
    listAgents:
      listAgentsImpl ??
      (async () => {
        const users = await listUsersImpl();
        return users.map(({ id, name }) => ({ id, name }));
      }),
    getUser: async (id: string) => ({
      id,
      name: "noop",
      email: "noop@example.com",
      slackId: null,
      role: "OWNER" as const,
      workingHoursStart: "09:00",
      workingHoursEnd: "17:00",
      timezone: "UTC",
      mercuryCounterparty: null,
      ownerUserId: null,
      clientId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    createUser: notImplemented,
    updateUser: notImplemented,
    listClients: async () => [],
    getClient: notImplemented,
    createClient: notImplemented,
    updateClient: notImplemented,
    deleteClient: notImplemented,
    listEngagements: async () => [],
    getEngagement: notImplemented,
    createEngagement: notImplemented,
    updateEngagement: notImplemented,
    deleteEngagement: notImplemented,
    listOAuthConnections: async () => [],
    getOAuthConnection: async () => null,
    deleteOAuthConnection: notImplemented,
    getOAuthToken: notImplemented,
    listConnections: async () => [],
    getConnectionToken: notImplemented,
    getAgentEnv: notImplemented,
    upsertAgentEnv: notImplemented,
    patchAgentEnv: notImplemented,
    getAgentConfigBundle: notImplemented,
    listAgentEnvs: async () => [],
    createAgentToken: notImplemented,
    getTeam: async () => null,
    listTeams: async () => [],
    listEnabledCronJobs: async () => [],
    listAgentCronJobs: async () => [],
    createAgentCronJob: notImplemented,
    deleteAgentCronJob: notImplemented,
    setAgentCronJobEnabled: notImplemented,
    reconcileSystemCrons: async () => ({ created: 0, updated: 0, deleted: 0 }),
    validateAgentToken: async () => null,
  };
}
