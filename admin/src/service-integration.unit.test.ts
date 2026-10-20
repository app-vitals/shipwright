import { describe, expect, it } from "bun:test";
import { deleteAgentFully } from "./agent-deletion.ts";
import { buildAgentDeploymentManifest } from "./agent-manifest.ts";
import {
  provisionableIntegrations,
  type ServiceIntegration,
} from "./service-integration.ts";

function integration(
  name: string,
  url: string | undefined,
  log: string[] = [],
): ServiceIntegration {
  return {
    name,
    url,
    tokenEnv: `SVC_${name.toUpperCase()}_TOKEN`,
    urlEnv: `SVC_${name.toUpperCase()}_URL`,
    secretKey: `${name}-token`,
    mintToken: async () => ({ id: `${name}-id`, rawToken: `${name}-raw` }),
    revokeToken: async (id) => {
      log.push(`revoke:${id}`);
    },
    listTokensForAgent: async () => [{ id: `${name}-id` }],
  };
}

describe("provisionableIntegrations", () => {
  it("returns [] for undefined or empty input", () => {
    expect(provisionableIntegrations(undefined)).toEqual([]);
    expect(provisionableIntegrations([])).toEqual([]);
  });

  it("keeps list order", () => {
    const list = [integration("b", "http://b"), integration("a", "http://a")];
    expect(provisionableIntegrations(list).map((i) => i.name)).toEqual([
      "b",
      "a",
    ]);
  });

  it("drops integrations without a url (optionality)", () => {
    const list = [
      integration("a", "http://a"),
      integration("b", undefined),
      integration("c", ""),
    ];
    expect(provisionableIntegrations(list).map((i) => i.name)).toEqual(["a"]);
  });
});

describe("service integrations in the Deployment manifest", () => {
  const base = {
    agentId: "agent-1",
    namespace: "ns",
    image: "img",
    imageTag: "t",
    apiUrl: "http://api",
    secretName: "agent-1-token",
    pvcName: "agent-1-home",
  };

  it("emits token then url env per integration, in list order, before chat", () => {
    const d = buildAgentDeploymentManifest({
      ...base,
      serviceIntegrations: [
        integration("a", "http://a"),
        integration("b", "http://b"),
      ],
      chatServiceUrl: "http://chat",
    });
    const names = (d.spec.template.spec.containers[0].env ?? []).map(
      (e) => e.name,
    );
    expect(names.slice(6)).toEqual([
      "SVC_A_TOKEN",
      "SVC_A_URL",
      "SVC_B_TOKEN",
      "SVC_B_URL",
      "SHIPWRIGHT_CHAT_SERVICE_TOKEN",
      "SHIPWRIGHT_CHAT_SERVICE_URL",
    ]);
  });

  it("omits an integration without a url", () => {
    const d = buildAgentDeploymentManifest({
      ...base,
      serviceIntegrations: [integration("a", undefined)],
    });
    const names = (d.spec.template.spec.containers[0].env ?? []).map(
      (e) => e.name,
    );
    expect(names).toHaveLength(6);
  });
});

describe("service integrations in agent deletion", () => {
  it("runs one name-tokens step per integration, in order, before chat", async () => {
    const log: string[] = [];
    const result = await deleteAgentFully("agent-1", {
      prisma: {
        agent: {
          findUnique: async () => ({ id: "agent-1", name: "agent-1" }),
          delete: async () => ({}),
        },
        agentEnv: { findMany: async () => [] },
      } as never,
      provisioner: { deprovision: async () => {} } as never,
      serviceIntegrations: [
        integration("a", "http://a", log),
        integration("b", undefined, log),
      ],
      chatService: {
        listTokensForAgent: async () => [],
        revokeToken: async () => {},
        deleteThreadsForAgent: async () => ({ deleted: 0 }),
      },
      slack: { deleteApp: async () => {} },
      decrypt: (v) => v,
    });
    expect(result.completed).toEqual([
      "k8s",
      "a-tokens",
      "b-tokens",
      "chat-service-tokens-and-threads",
    ]);
    expect(log).toEqual(["revoke:a-id", "revoke:b-id"]);
  });
});
