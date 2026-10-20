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

const ctx = { env: {} } as unknown as AdminExtensionContext;

describe("codingAdminExtension", () => {
  it("is named coding", () => {
    expect(codingAdminExtension.name).toBe("coding");
  });

  it("registers no routes/cards/passes yet: the context hooks resolve as the bare platform", () => {
    expect(resolveAdminExtensions([codingAdminExtension], ctx)).toEqual(
      resolveAdminExtensions([], ctx),
    );
    expect(collectOpenApiContributions([codingAdminExtension])).toEqual(
      collectOpenApiContributions([]),
    );
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
