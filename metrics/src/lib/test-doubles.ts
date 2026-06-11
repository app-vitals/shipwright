/**
 * metrics/src/lib/test-doubles.ts
 * Test doubles for the metrics service.
 * Provides FixedClock and makeAccountsClientMock for use in tests.
 */

import type {
  AccountsClient,
  AgentRecord,
  UserRecord,
} from "./accounts-client.ts";
import type { Clock } from "./clock.ts";

// ─── FixedClock ───────────────────────────────────────────────────────────────

/**
 * Test double for the `Clock` interface.
 *
 * Returns a frozen time that can be advanced deterministically via `advance(ms)`.
 * Each instance maintains its own offset — advancing one clock has no effect on
 * any other.
 *
 * @param t - Starting time as a `Date` or ISO 8601 string.
 */
export function FixedClock(
  t: Date | string,
): Clock & { advance(ms: number): void } {
  let current = typeof t === "string" ? new Date(t) : new Date(t.getTime());
  return {
    now(): Date {
      return new Date(current.getTime());
    },
    advance(ms: number): void {
      current = new Date(current.getTime() + ms);
    },
  };
}

// ─── makeAccountsClientMock ──────────────────────────────────────────────────

/**
 * Minimal AccountsClient stub for tests that need to control listUsers /
 * listAgents output but don't exercise any other accounts methods. All other
 * methods throw "not implemented".
 *
 * Usage:
 *   makeAccountsClientMock(async () => [])          // no users
 *   makeAccountsClientMock(async () => [user])      // one user
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
    listAgents: listAgentsImpl ?? (async () => []),
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
