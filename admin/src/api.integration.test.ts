/**
 * agent/src/api.integration.test.ts
 * Integration tests for the runtime API (GET /:id/config) against a real
 * PostgreSQL DB, using real services (not mocks) end-to-end.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 *
 * Complements api.smoke.test.ts (mocked services) — this file exercises the
 * real Prisma-backed AgentPhaseMethodologyService wired through the actual
 * admin CRUD routes (PUT /agents/:id/phase-methodology/:phase) and verifies
 * the runtime GET /:id/config route reflects those writes (PMC-1.1).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentCronJobService } from "./agent-cron-jobs.ts";
import { AgentEnvService } from "./agent-envs.ts";
import { AgentPhaseMethodologyService } from "./agent-phase-methodology.ts";
import { AgentPluginService } from "./agent-plugins.ts";
import { AgentTokenService } from "./agent-tokens.ts";
import { AgentService } from "./agents.ts";
import { createAdminApp, parseAdminApiKeys } from "./agents-api.ts";
import { createAgentRuntimeApp } from "./api.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import { makeTokenCrypto } from "./token-crypto.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const SESSION_SECRET = "test-runtime-session-secret-32bytes!";
const ADMIN_API_KEY = "test-runtime-admin-key";
const REAL_KEY =
  "0000000000000000000000000000000000000000000000000000000000000001";

function makePrisma(): PrismaClient {
  return createAdminPrismaClient(TEST_DB as string);
}

async function createAgent(
  prisma: PrismaClient,
  name = "Test Agent",
): Promise<string> {
  const agent = await prisma.agent.create({ data: { name } });
  return agent.id;
}

describeOrSkip(
  "runtime GET /:id/config + admin PUT /phase-methodology (integration)",
  () => {
    let prisma: PrismaClient;
    let agentId: string;
    let runtimeApp: ReturnType<typeof createAgentRuntimeApp>;
    let adminApp: ReturnType<typeof createAdminApp>;

    beforeEach(async () => {
      prisma = makePrisma();
      await prisma.agentPhaseMethodology.deleteMany();
      await prisma.agentPlugin.deleteMany();
      await prisma.agentToken.deleteMany();
      await prisma.agentCronJob.deleteMany();
      await prisma.agentTool.deleteMany();
      await prisma.agentEnv.deleteMany();
      await prisma.agentMember.deleteMany();
      await prisma.agent.deleteMany();

      agentId = await createAgent(prisma);

      const savedKey = process.env.SHIPWRIGHT_ENCRYPTION_KEY;
      process.env.SHIPWRIGHT_ENCRYPTION_KEY = REAL_KEY;
      const crypto = makeTokenCrypto();
      if (savedKey === undefined) {
        delete process.env.SHIPWRIGHT_ENCRYPTION_KEY;
      } else {
        process.env.SHIPWRIGHT_ENCRYPTION_KEY = savedKey;
      }

      const agentEnvService = new AgentEnvService(prisma, crypto);
      const agentCronJobService = new AgentCronJobService(prisma);
      const agentService = new AgentService(prisma);
      const agentPluginService = new AgentPluginService(prisma);
      const agentPhaseMethodologyService = new AgentPhaseMethodologyService(
        prisma,
      );
      const agentTokenService = new AgentTokenService(prisma);
      const adminApiKeys = parseAdminApiKeys(`admin:${ADMIN_API_KEY}:*`);

      runtimeApp = createAgentRuntimeApp({
        agentEnvService,
        agentCronJobService,
        agentService,
        agentPluginService,
        agentPhaseMethodologyService,
        sessionSecret: SESSION_SECRET,
        adminApiKeys,
        agentTokenService,
      });

      // Minimal real admin app wired with the same real
      // agentPhaseMethodologyService, so PUT writes are visible to the
      // runtime app's GET /:id/config read against the same DB.
      adminApp = createAdminApp({
        agentService,
        agentEnvService,
        agentCronJobService,
        agentCronRunService: {
          create: async () => {
            throw new Error("not implemented");
          },
          list: async () => ({ items: [], total: 0, limit: 20, offset: 0 }),
          patch: async () => {
            throw new Error("not implemented");
          },
        },
        agentCronRunStatsService: {
          outcomes: async () => ({ series: [] }),
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
          add: async () => {
            throw new Error("not implemented");
          },
          remove: async () => {},
          toggle: async () => {
            throw new Error("not implemented");
          },
        },
        agentTokenService,
        agentPluginService,
        agentPhaseMethodologyService,
        agentMemberService: {
          add: async () => {
            throw new Error("not implemented");
          },
          listByAgentId: async () => [],
        },
        agentTypeRegistry: {
          getManifest: () => {
            throw new Error("not implemented");
          },
          tryGetManifest: () => undefined,
          listTypes: () => [],
        },
        agentChatTokenService: {
          upsertDailyByModel: async () => {
            throw new Error("not implemented");
          },
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
        agentWorkQueueService: {
          push: async () => {
            throw new Error("not implemented");
          },
          get: async () => null,
        },
        agentGitHubInstallationsService: {
          push: async () => {
            throw new Error("not implemented");
          },
          get: async () => null,
        },
        prisma,
        provisioner: {
          provision: async () => {
            throw new Error("not implemented");
          },
          deprovision: async () => {},
          reconcileAll: async () => {
            throw new Error("not implemented");
          },
        } as never,
        taskStore: {
          listTokensForAgent: async () => [],
          revokeToken: async () => {},
        },
        chatService: {
          listTokensForAgent: async () => [],
          revokeToken: async () => {},
          deleteThreadsForAgent: async () => ({ deleted: 0 }),
        },
        slack: { deleteApp: async () => {} },
        decrypt: (value: string) => crypto.decrypt(value),
        sessionSecret: SESSION_SECRET,
        adminApiKeys,
      });
    });

    afterEach(async () => {
      await prisma.$disconnect();
    });

    it("GET /:id/config returns phaseMethodology with all six phases defaulting to null when no overrides exist", async () => {
      const res = await runtimeApp.request(`/${agentId}/config`, {
        headers: { Authorization: `Bearer ${ADMIN_API_KEY}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.phaseMethodology).toEqual({
        prd: null,
        "plan-session": null,
        review: null,
        patch: null,
        deploy: null,
        "dev-task": null,
      });
    });

    it("GET /:id/config reflects a real PUT /agents/:id/phase-methodology/:phase write", async () => {
      const putRes = await adminApp.request(
        `/agents/${agentId}/phase-methodology/patch`,
        {
          method: "PUT",
          body: JSON.stringify({ subagentType: "shipwright:patcher" }),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ADMIN_API_KEY}`,
          },
        },
      );
      expect(putRes.status).toBe(200);

      const res = await runtimeApp.request(`/${agentId}/config`, {
        headers: { Authorization: `Bearer ${ADMIN_API_KEY}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.phaseMethodology.patch).toBe("shipwright:patcher");
      expect(body.phaseMethodology.review).toBeNull();
    });
  },
);
