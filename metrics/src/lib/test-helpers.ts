/**
 * metrics/src/lib/test-helpers.ts
 * Test doubles for the metrics package.
 * NOT exported from index.ts — test-only.
 */

import type { AccountsClient, UserRecord } from "./accounts-client.ts";
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
 * Minimal AccountsClient stub for tests that need to control listUsers output.
 */
export function makeAccountsClientMock(
  listUsersImpl: () => Promise<UserRecord[]>,
): AccountsClient {
  const notImplemented = async (): Promise<never> => {
    throw new Error("not implemented");
  };
  return {
    listUsers: listUsersImpl,
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

// ─── runCanaryMode ────────────────────────────────────────────────────────────

const LOCAL_BASE_URL = "http://localhost:3000";
const LOCAL_API_KEY = "local-test-api-key";

type CleanupFn = () => void | Promise<void>;

export interface CanaryContext {
  baseUrl: string;
  apiKey: string;
  onCleanup: (fn: CleanupFn) => void;
}

export async function runCanaryMode<T>(
  fn: (ctx: CanaryContext) => Promise<T>,
): Promise<T> {
  const targetUrl = process.env.TEST_TARGET_URL;
  const isCanary = Boolean(targetUrl);

  let baseUrl: string;
  let apiKey: string;

  if (isCanary) {
    const canaryKey = process.env.TEST_CANARY_API_KEY;
    if (!canaryKey) {
      throw new Error(
        "TEST_CANARY_API_KEY is required when TEST_TARGET_URL is set",
      );
    }
    baseUrl = targetUrl as string;
    apiKey = canaryKey;
  } else {
    baseUrl = LOCAL_BASE_URL;
    apiKey = LOCAL_API_KEY;
  }

  const cleanupFns: CleanupFn[] = [];

  const ctx: CanaryContext = {
    baseUrl,
    apiKey,
    onCleanup(fn: CleanupFn) {
      cleanupFns.push(fn);
    },
  };

  let result!: T;
  let testError: unknown;
  let didThrow = false;

  try {
    result = await fn(ctx);
  } catch (e) {
    testError = e;
    didThrow = true;
  }

  const cleanupErrors: unknown[] = [];
  for (const cleanup of cleanupFns) {
    try {
      await cleanup();
    } catch (e) {
      cleanupErrors.push(e);
    }
  }

  if (cleanupErrors.length > 0) {
    const all = didThrow ? [testError, ...cleanupErrors] : cleanupErrors;
    throw all.length === 1 ? all[0] : new AggregateError(all, "cleanup errors");
  }

  if (didThrow) throw testError;
  return result;
}
