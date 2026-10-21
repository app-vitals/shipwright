import { describe, expect, it } from "bun:test";
import {
  type AdminExtensionContext,
  collectOpenApiContributions,
  collectServiceIntegrations,
  resolveAdminExtensions,
} from "./admin-extension.ts";
import {
  codingAdminExtension,
  taskStoreServiceIntegration,
} from "./coding-admin-extension.ts";
import {
  HttpTaskStoreProvisioningClient,
  NoopTaskStoreProvisioningClient,
} from "./coding-task-store-provisioning-client.ts";

const ctx = {
  env: {},
  prisma: {},
  services: {},
} as unknown as AdminExtensionContext;

describe("codingAdminExtension", () => {
  it("is named coding", () => {
    expect(codingAdminExtension.name).toBe("coding");
  });

  it("contributes its agent detail cards in page order: two header cards, then Phase Methodology in the Configuration group", () => {
    const { agentDetailCards } = resolveAdminExtensions(
      [codingAdminExtension],
      ctx,
    );
    expect(
      agentDetailCards.map((card) => [card.name, card.placement ?? "header"]),
    ).toEqual([
      ["verification-activity", "header"],
      ["github-installations", "header"],
      ["phase-methodology", "configuration"],
    ]);
  });

  it("registers no API routes or OpenAPI contributions yet", () => {
    const resolved = resolveAdminExtensions([codingAdminExtension], ctx);
    expect(resolved.apiRoutes).toEqual([]);
    expect(collectOpenApiContributions([codingAdminExtension])).toEqual(
      collectOpenApiContributions([]),
    );
  });

  it("mounts its own admin UI routes and contributes its agent detail error messages", () => {
    const resolved = resolveAdminExtensions([codingAdminExtension], {
      ...ctx,
      env: {
        SHIPWRIGHT_TASK_STORE_URL: "http://task-store.svc:3002",
        SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN: "admin",
      },
    } as unknown as AdminExtensionContext);
    expect(resolved.adminUiRoutes.map((route) => route.path)).toEqual(["/"]);
    expect(resolved.uiDeps).toEqual({
      agentDetailErrorMessages: { invalid_phase: "Invalid pipeline phase." },
    });
  });

  it("starts the session alert sweeper only with push AND the task-store configured", () => {
    const env = {
      SHIPWRIGHT_TASK_STORE_URL: "http://task-store.svc:3002",
      SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN: "admin",
    };
    const services = {
      agentMemberService: {},
      agentService: {},
      callerScopeResolver: {},
    };
    const push = { service: {}, maxDetail: "title" };
    const passes = (extra: Record<string, unknown>) =>
      resolveAdminExtensions([codingAdminExtension], {
        prisma: {},
        adminAllowedEmails: [],
        services,
        ...extra,
      } as unknown as AdminExtensionContext).backgroundPasses;

    expect(passes({ env })).toEqual([]);
    expect(passes({ env: {}, push })).toEqual([]);
    const [pass] = passes({ env, push });
    expect(pass).toMatchObject({
      name: "session alert sweeper",
      logPrefix: "[session-alert-sweeper]",
    });
    expect(passes({ env, push })).toHaveLength(1);
  });

  it("registers the task-store service integration", () => {
    const env = {
      SHIPWRIGHT_TASK_STORE_URL: "http://task-store.svc:3002",
      SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN: "admin",
    };
    const integrations = collectServiceIntegrations(
      [codingAdminExtension],
      env,
    );
    expect(integrations.map((i) => i.name)).toEqual(["task-store"]);
    const [ts] = integrations;
    expect(ts).toMatchObject({
      tokenEnv: "SHIPWRIGHT_TASK_STORE_TOKEN",
      urlEnv: "SHIPWRIGHT_TASK_STORE_URL",
      secretKey: "task-store-token",
      url: "http://task-store.svc:3002",
    });
  });
});

describe("taskStoreServiceIntegration", () => {
  it("has no url when the URL or admin token is missing, but still lists/revokes as a no-op", async () => {
    for (const env of [
      {},
      { SHIPWRIGHT_TASK_STORE_URL: "http://t" },
      { SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN: "x" },
    ]) {
      const ts = taskStoreServiceIntegration(env);
      expect(ts.url).toBeUndefined();
      expect(await ts.listTokensForAgent("a")).toEqual([]);
      expect(await ts.mintToken("l", "a")).toEqual({ id: "", rawToken: "" });
    }
  });

  it("delegates to the HTTP client when fully configured", async () => {
    const calls: string[] = [];
    const orig = HttpTaskStoreProvisioningClient.prototype.listTokensForAgent;
    HttpTaskStoreProvisioningClient.prototype.listTokensForAgent = async (
      agentId: string,
    ) => {
      calls.push(agentId);
      return [{ id: "t1" }];
    };
    try {
      const ts = taskStoreServiceIntegration({
        SHIPWRIGHT_TASK_STORE_URL: "http://t",
        SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN: "x",
      });
      expect(await ts.listTokensForAgent("agent-9")).toEqual([{ id: "t1" }]);
      expect(calls).toEqual(["agent-9"]);
    } finally {
      HttpTaskStoreProvisioningClient.prototype.listTokensForAgent = orig;
    }
    expect(NoopTaskStoreProvisioningClient).toBeDefined();
  });
});
