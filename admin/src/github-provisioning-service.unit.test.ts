/**
 * admin/src/github-provisioning-service.unit.test.ts
 * Unit tests for GithubProvisioningService.completeInstalled() — the
 * additional-org path (stored installation ID, no provision-state cookie)
 * versus the first-install path (state cookie required).
 */

import { describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import { GithubProvisioningService } from "./github-provisioning-service.ts";

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const AGENT_ID = "agent-test-123";

function makeService(storedInstallationId?: string) {
  const patchCalls: Array<Record<string, string>> = [];
  const reconcileCalls: string[] = [];
  const service = new GithubProvisioningService({
    githubAppClient: {} as never,
    agentService: {} as never,
    agentEnvService: {
      getByAgentId: async () => ({
        env: storedInstallationId
          ? { GH_APP_INSTALLATION_ID: storedInstallationId }
          : {},
        secretKeys: [],
      }),
      patch: async (_id: string, env: Record<string, string>) => {
        patchCalls.push(env);
      },
    } as never,
    agentCronJobService: {
      reconcileSystemCrons: async (id: string) => {
        reconcileCalls.push(id);
        return { created: 0, updated: 0, deleted: 0 };
      },
    } as never,
    sessionSecret: SESSION_SECRET,
    appBaseUrl: "https://example.com",
    secretEnvVars: new Set(),
  });
  return { service, patchCalls, reconcileCalls };
}

async function stateCookie(agentId = AGENT_ID): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    { agentId, githubOrg: "my-org", iat: now, exp: now + 300 },
    SESSION_SECRET,
    "HS256",
  );
}

describe("GithubProvisioningService.completeInstalled", () => {
  it("stored ID + no cookie + numeric installation_id → success alreadyStored, no write", async () => {
    const { service, patchCalls } = makeService("111");
    const result = await service.completeInstalled(
      undefined,
      "778899",
      AGENT_ID,
    );
    expect(result).toEqual({
      outcome: "success",
      agentId: AGENT_ID,
      alreadyStored: true,
    });
    expect(patchCalls).toHaveLength(0);
  });

  it("stored ID + no cookie + non-numeric installation_id → invalid_installation_id", async () => {
    const { service, patchCalls } = makeService("111");
    const result = await service.completeInstalled(undefined, "abc", AGENT_ID);
    expect(result.outcome).toBe("invalid_installation_id");
    expect(patchCalls).toHaveLength(0);
  });

  it("stored ID + missing installation_id → invalid_installation_id", async () => {
    const { service } = makeService("111");
    const result = await service.completeInstalled(
      undefined,
      undefined,
      AGENT_ID,
    );
    expect(result.outcome).toBe("invalid_installation_id");
  });

  it("no stored ID + no cookie → invalid_state", async () => {
    const { service, patchCalls } = makeService();
    const result = await service.completeInstalled(
      undefined,
      "778899",
      AGENT_ID,
    );
    expect(result.outcome).toBe("invalid_state");
    expect(patchCalls).toHaveLength(0);
  });

  it("no stored ID + valid cookie → stores the installation ID and reconciles crons", async () => {
    const { service, patchCalls, reconcileCalls } = makeService();
    const result = await service.completeInstalled(
      await stateCookie(),
      "778899",
      AGENT_ID,
    );
    expect(result).toEqual({
      outcome: "success",
      agentId: AGENT_ID,
      alreadyStored: false,
    });
    expect(patchCalls).toEqual([{ GH_APP_INSTALLATION_ID: "778899" }]);
    expect(reconcileCalls).toEqual([AGENT_ID]);
  });

  it("no stored ID + cookie for a different agent → agent_mismatch", async () => {
    const { service } = makeService();
    const result = await service.completeInstalled(
      await stateCookie("other-agent"),
      "778899",
      AGENT_ID,
    );
    expect(result.outcome).toBe("agent_mismatch");
  });
});
