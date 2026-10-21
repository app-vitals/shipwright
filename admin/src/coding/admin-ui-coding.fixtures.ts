/**
 * admin/src/coding/admin-ui-coding.fixtures.ts
 * Test doubles for the coding extension's admin UI smoke tests: the platform
 * doubles from admin-ui.fixtures.ts plus the coding deps, and an app that
 * composes the platform admin UI with the coding extension's contributions
 * (routes, agent detail cards, error messages) the way startAdmin() does
 * (AEP-3.2).
 */

import { Hono } from "hono";
import { MOCK_CRON, makeMockDeps } from "../admin-ui.fixtures.ts";
import { type AdminUIDeps, createAdminUIApp } from "../admin-ui.ts";
import {
  type CodingAgentDetailCardDeps,
  codingAgentDetailCards,
} from "./admin-ui-agent-cards.ts";
import {
  CODING_AGENT_DETAIL_ERROR_MESSAGES,
  type CodingAdminUIDeps,
  createCodingAdminUIApp,
} from "./admin-ui-coding.ts";

/** The platform admin UI deps plus the coding UI's and cards' deps. */
export type CodingMockDeps = AdminUIDeps &
  CodingAdminUIDeps &
  CodingAgentDetailCardDeps;

/** The coding deps' defaults: empty task-store views, no snapshots. */
function codingDefaults(): Omit<
  CodingAdminUIDeps,
  | "prisma"
  | "sessionSecret"
  | "appBaseUrl"
  | "agentService"
  | "agentCronJobService"
  | "agentMemberService"
> &
  CodingAgentDetailCardDeps {
  return {
    // Default: every requested agent has an enabled shipwright-loop cron,
    // matching the platform doubles' agentCronJobService defaults (MOCK_CRON
    // is enabled: true) and preserving pre-QAE-1.2 eligibility behavior for
    // tests that don't specifically exercise loop-enabled gating.
    shipwrightLoopJobService: {
      listShipwrightLoopJobs: async (agentIds: string[]) =>
        agentIds.map((agentId) => ({
          ...MOCK_CRON,
          agentId,
          name: "shipwright-loop",
          enabled: true,
        })),
    },
    agentCronRunService: {
      listForAgent: async () => ({ items: [], total: 0, limit: 20, offset: 0 }),
      listAcrossAgents: async () => ({
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
      }),
    },
    agentWorkQueueService: {
      get: async () => null,
      getMany: async () => [],
    },
    agentPhaseMethodologyService: {
      list: async () => [],
      upsert: async (
        agentId: string,
        phase: string,
        subagentType: string | null,
      ) => ({
        id: "pm1",
        agentId,
        phase,
        subagentType,
        updatedAt: new Date("2024-01-01"),
      }),
    },
  };
}

/** makeMockDeps() plus the coding deps' defaults; overrides win. */
export function makeCodingMockDeps(
  overrides?: Partial<CodingMockDeps> & Parameters<typeof makeMockDeps>[0],
): CodingMockDeps {
  return {
    ...codingDefaults(),
    ...makeMockDeps(overrides as Parameters<typeof makeMockDeps>[0]),
  } as CodingMockDeps;
}

/**
 * The platform admin UI with the coding extension's contributions — its
 * agent detail cards and error messages, and its own UI routes mounted after
 * the platform's — wired from the same deps, as startAdmin() composes them.
 */
export function createCodingTestApp(deps: CodingMockDeps) {
  const root = new Hono();
  root.route(
    "/",
    createAdminUIApp({
      ...deps,
      agentDetailCards: codingAgentDetailCards(deps),
      agentDetailErrorMessages: CODING_AGENT_DETAIL_ERROR_MESSAGES,
      queueActivityLinks: true,
    }),
  );
  root.route("/", createCodingAdminUIApp(deps));
  return root;
}
