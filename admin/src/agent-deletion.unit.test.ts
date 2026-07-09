/**
 * admin/src/agent-deletion.unit.test.ts
 * Unit tests for deleteAgentFully() — the shared, idempotent agent-deletion
 * orchestration. All collaborators (provisioner, taskStoreClient,
 * chatServiceClient, slackClient, prisma) are injected fakes/stubs — no real
 * I/O, no DB, no network. Per the test-isolation convention, the fake Prisma
 * uses an in-memory Map so delete/findUnique reflect real state across calls
 * (needed for the retry test).
 */

import { describe, expect, it } from "bun:test";
import { type AgentDeletionDeps, deleteAgentFully } from "./agent-deletion.ts";
import type { AgentProvisioner } from "./agent-provisioner.ts";
import type { ChatServiceProvisioningClient } from "./chat-service-provisioning-client.ts";
import type { SlackProvisioningClient } from "./slack-provisioning-client.ts";
import type { TaskStoreProvisioningClient } from "./task-store-provisioning-client.ts";

// ─── Fakes ──────────────────────────────────────────────────────────────────

interface FakeAgentRow {
  id: string;
  name: string;
}

interface FakeAgentEnvRow {
  id: string;
  agentId: string;
  key: string;
  value: string;
  secret: boolean;
}

/**
 * In-memory fake matching only the Prisma shape deleteAgentFully() actually
 * calls: agent.findUnique (with envVars include) and agent.delete. Deleting
 * removes the row from the Map so a later findUnique legitimately returns
 * null — this is what makes the retry test a real assertion rather than a
 * mocked stub.
 */
function fakePrisma(
  agents: FakeAgentRow[],
  envRows: FakeAgentEnvRow[],
): AgentDeletionDeps["prisma"] {
  const agentMap = new Map(agents.map((a) => [a.id, a]));
  return {
    agent: {
      async findUnique({ where: { id } }: { where: { id: string } }) {
        const agent = agentMap.get(id);
        if (!agent) return null;
        return {
          ...agent,
          envVars: envRows.filter((e) => e.agentId === id),
        };
      },
      async delete({ where: { id } }: { where: { id: string } }) {
        agentMap.delete(id);
      },
    },
  };
}

function fakeProvisioner(opts?: {
  deprovision?: (agentId: string, opts?: { slug?: string }) => Promise<void>;
}): AgentProvisioner {
  return {
    provision: async () => {
      throw new Error("not used in these tests");
    },
    deprovision:
      opts?.deprovision ??
      (async () => {
        /* success no-op */
      }),
    reconcile: async () => ({
      recreated: [],
      orphans: [],
      failed: [],
      updated: [],
    }),
  };
}

function fakeTaskStoreClient(opts?: {
  revokeToken?: (id: string) => Promise<void>;
  tokens?: { id: string }[];
}): TaskStoreProvisioningClient {
  return {
    mintToken: async () => ({ id: "", rawToken: "" }),
    revokeToken: opts?.revokeToken ?? (async () => {}),
    listTokensForAgent: async () => opts?.tokens ?? [{ id: "ts-tok-1" }],
  };
}

function fakeChatServiceClient(opts?: {
  revokeToken?: (id: string) => Promise<void>;
  tokens?: { id: string }[];
  deleteThreadsForAgent?: (agentId: string) => Promise<{ deleted: number }>;
}): ChatServiceProvisioningClient {
  return {
    mintToken: async () => ({ id: "", rawToken: "" }),
    revokeToken: opts?.revokeToken ?? (async () => {}),
    listTokensForAgent: async () => opts?.tokens ?? [{ id: "cs-tok-1" }],
    deleteThreadsForAgent:
      opts?.deleteThreadsForAgent ?? (async () => ({ deleted: 0 })),
  };
}

function fakeSlackClient(opts?: {
  deleteApp?: (xoxpToken: string, appId: string) => Promise<void>;
}): SlackProvisioningClient {
  return {
    createAppManifest: async () => {
      throw new Error("not used in these tests");
    },
    updateAppManifest: async () => {
      throw new Error("not used in these tests");
    },
    deleteApp: opts?.deleteApp ?? (async () => {}),
    exchangeOAuthCode: async () => {
      throw new Error("not used in these tests");
    },
  };
}

const AGENT_ID = "agent-123";

// ─── AC 1: Happy path ───────────────────────────────────────────────────────

describe("deleteAgentFully — happy path", () => {
  it("completes every step, deletes the Agent row, and lists slack in completed when a token is supplied", async () => {
    const agents: FakeAgentRow[] = [{ id: AGENT_ID, name: "my-agent" }];
    const envRows: FakeAgentEnvRow[] = [
      {
        id: "e1",
        agentId: AGENT_ID,
        key: "SLACK_APP_ID",
        value: "A0123456789",
        secret: true,
      },
      {
        id: "e2",
        agentId: AGENT_ID,
        key: "GH_TOKEN",
        value: "ghp_fake",
        secret: true,
      },
    ];
    const prisma = fakePrisma(agents, envRows);

    const deprovisionCalls: Array<{ agentId: string; slug?: string }> = [];
    const provisioner = fakeProvisioner({
      deprovision: async (agentId, opts) => {
        deprovisionCalls.push({ agentId, slug: opts?.slug });
      },
    });

    const deleteAppCalls: Array<{ xoxpToken: string; appId: string }> = [];
    const slackClient = fakeSlackClient({
      deleteApp: async (xoxpToken, appId) => {
        deleteAppCalls.push({ xoxpToken, appId });
      },
    });

    const taskStoreClient = fakeTaskStoreClient();
    const chatServiceClient = fakeChatServiceClient();

    const deps: AgentDeletionDeps = {
      prisma,
      provisioner,
      taskStoreClient,
      chatServiceClient,
      slackClient,
    };

    const result = await deleteAgentFully(AGENT_ID, deps, {
      xoxpToken: "xoxe.xoxp-fake-token",
    });

    expect(result.agentDeleted).toBe(true);
    expect(result.completed).toContain("k8s");
    expect(result.completed).toContain("task-store");
    expect(result.completed).toContain("chat-service");
    expect(result.completed).toContain("slack");
    expect(result.failed).toEqual([]);

    // Only the non-slack-managed secret produces a manual checklist entry.
    expect(result.manualStepsRequired).toHaveLength(1);
    expect(result.manualStepsRequired[0].key).toBe("GH_TOKEN");

    expect(deprovisionCalls).toEqual([{ agentId: AGENT_ID, slug: "my-agent" }]);
    expect(deleteAppCalls).toEqual([
      { xoxpToken: "xoxe.xoxp-fake-token", appId: "A0123456789" },
    ]);

    // Agent row is actually gone.
    const found = await prisma.agent.findUnique({
      where: { id: AGENT_ID },
      include: { envVars: true },
    });
    expect(found).toBeNull();
  });

  it("does not attempt slack deletion when SLACK_APP_ID is absent, and completed omits slack", async () => {
    const agents: FakeAgentRow[] = [{ id: AGENT_ID, name: "my-agent" }];
    const envRows: FakeAgentEnvRow[] = [
      {
        id: "e2",
        agentId: AGENT_ID,
        key: "GH_TOKEN",
        value: "ghp_fake",
        secret: true,
      },
    ];
    const prisma = fakePrisma(agents, envRows);

    let deleteAppCalled = false;
    const slackClient = fakeSlackClient({
      deleteApp: async () => {
        deleteAppCalled = true;
      },
    });

    const deps: AgentDeletionDeps = {
      prisma,
      provisioner: fakeProvisioner(),
      taskStoreClient: fakeTaskStoreClient(),
      chatServiceClient: fakeChatServiceClient(),
      slackClient,
    };

    const result = await deleteAgentFully(AGENT_ID, deps, {
      xoxpToken: "xoxe.xoxp-fake-token",
    });

    expect(deleteAppCalled).toBe(false);
    expect(result.completed).not.toContain("slack");
    expect(result.agentDeleted).toBe(true);
    // No manual entry for slack since it wasn't applicable at all.
    expect(
      result.manualStepsRequired.some((s) => s.key === "SLACK_APP_ID"),
    ).toBe(false);
  });
});

// ─── AC 2: Partial failure ──────────────────────────────────────────────────

describe("deleteAgentFully — partial failure", () => {
  it("when task-store token revoke throws, agentDeleted is false, the Agent row still exists, failed names the step, and k8s still completed", async () => {
    const agents: FakeAgentRow[] = [{ id: AGENT_ID, name: "my-agent" }];
    const envRows: FakeAgentEnvRow[] = [];
    const prisma = fakePrisma(agents, envRows);

    let deprovisionCalled = false;
    const provisioner = fakeProvisioner({
      deprovision: async () => {
        deprovisionCalled = true;
      },
    });

    const taskStoreClient = fakeTaskStoreClient({
      revokeToken: async () => {
        throw new Error("task-store unreachable");
      },
    });

    const deps: AgentDeletionDeps = {
      prisma,
      provisioner,
      taskStoreClient,
      chatServiceClient: fakeChatServiceClient(),
      slackClient: fakeSlackClient(),
    };

    const result = await deleteAgentFully(AGENT_ID, deps);

    expect(result.agentDeleted).toBe(false);
    expect(deprovisionCalled).toBe(true);
    expect(result.completed).toContain("k8s");
    expect(result.completed).not.toContain("task-store");
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].step).toBe("task-store");
    expect(result.failed[0].error).toContain("task-store unreachable");

    // Agent row must still exist.
    const found = await prisma.agent.findUnique({
      where: { id: AGENT_ID },
      include: { envVars: true },
    });
    expect(found).not.toBeNull();
  });

  it("when k8s deprovision throws, chat-service and task-store steps still run rather than being skipped", async () => {
    const agents: FakeAgentRow[] = [{ id: AGENT_ID, name: "my-agent" }];
    const prisma = fakePrisma(agents, []);

    const provisioner = fakeProvisioner({
      deprovision: async () => {
        throw new Error("k8s API unavailable");
      },
    });

    let taskStoreRevoked = false;
    let chatServiceRevoked = false;
    let threadsDeleted = false;
    const taskStoreClient = fakeTaskStoreClient({
      revokeToken: async () => {
        taskStoreRevoked = true;
      },
    });
    const chatServiceClient = fakeChatServiceClient({
      revokeToken: async () => {
        chatServiceRevoked = true;
      },
      deleteThreadsForAgent: async () => {
        threadsDeleted = true;
        return { deleted: 0 };
      },
    });

    const deps: AgentDeletionDeps = {
      prisma,
      provisioner,
      taskStoreClient,
      chatServiceClient,
      slackClient: fakeSlackClient(),
    };

    const result = await deleteAgentFully(AGENT_ID, deps);

    expect(result.agentDeleted).toBe(false);
    expect(result.failed.map((f) => f.step)).toContain("k8s");
    expect(taskStoreRevoked).toBe(true);
    expect(chatServiceRevoked).toBe(true);
    expect(threadsDeleted).toBe(true);
    expect(result.completed).toContain("task-store");
    expect(result.completed).toContain("chat-service");

    const found = await prisma.agent.findUnique({
      where: { id: AGENT_ID },
      include: { envVars: true },
    });
    expect(found).not.toBeNull();
  });
});

// ─── AC 3: Retry ────────────────────────────────────────────────────────────

describe("deleteAgentFully — retry after partial failure", () => {
  it("a second call with the previously-failing dependency now healthy completes remaining steps and deletes the Agent row", async () => {
    const agents: FakeAgentRow[] = [{ id: AGENT_ID, name: "my-agent" }];
    const prisma = fakePrisma(agents, []);

    let deprovisionCallCount = 0;
    const provisioner = fakeProvisioner({
      deprovision: async () => {
        deprovisionCallCount++;
        // Simulates the real provisioner: idempotent, 404-tolerant — succeeds
        // both times, including "already gone" on the second call.
      },
    });

    let shouldFailTaskStore = true;
    const taskStoreClient = fakeTaskStoreClient({
      revokeToken: async () => {
        if (shouldFailTaskStore) {
          throw new Error("task-store down");
        }
        // Second call: token already revoked — idempotent no-op success.
      },
    });

    const deps: AgentDeletionDeps = {
      prisma,
      provisioner,
      taskStoreClient,
      chatServiceClient: fakeChatServiceClient(),
      slackClient: fakeSlackClient(),
    };

    const first = await deleteAgentFully(AGENT_ID, deps);
    expect(first.agentDeleted).toBe(false);
    expect(first.failed[0].step).toBe("task-store");

    // Dependency recovers.
    shouldFailTaskStore = false;

    const second = await deleteAgentFully(AGENT_ID, deps);
    expect(second.agentDeleted).toBe(true);
    expect(second.failed).toEqual([]);
    expect(second.completed).toContain("k8s");
    expect(second.completed).toContain("task-store");
    expect(second.completed).toContain("chat-service");

    expect(deprovisionCallCount).toBe(2);

    const found = await prisma.agent.findUnique({
      where: { id: AGENT_ID },
      include: { envVars: true },
    });
    expect(found).toBeNull();
  });
});

// ─── AC 4: Slack without token ──────────────────────────────────────────────

describe("deleteAgentFully — Slack app present but no token supplied", () => {
  it("adds a manual checklist entry for SLACK_APP_ID and does NOT mark agentDeleted false because of it alone", async () => {
    const agents: FakeAgentRow[] = [{ id: AGENT_ID, name: "my-agent" }];
    const envRows: FakeAgentEnvRow[] = [
      {
        id: "e1",
        agentId: AGENT_ID,
        key: "SLACK_APP_ID",
        value: "A0123456789",
        secret: true,
      },
    ];
    const prisma = fakePrisma(agents, envRows);

    let deleteAppCalled = false;
    const slackClient = fakeSlackClient({
      deleteApp: async () => {
        deleteAppCalled = true;
      },
    });

    const deps: AgentDeletionDeps = {
      prisma,
      provisioner: fakeProvisioner(),
      taskStoreClient: fakeTaskStoreClient(),
      chatServiceClient: fakeChatServiceClient(),
      slackClient,
    };

    // No opts.xoxpToken supplied.
    const result = await deleteAgentFully(AGENT_ID, deps);

    expect(deleteAppCalled).toBe(false);
    expect(result.completed).not.toContain("slack");
    expect(result.failed).toEqual([]);
    expect(result.agentDeleted).toBe(true);

    const manualSlackStep = result.manualStepsRequired.find(
      (s) => s.key === "SLACK_APP_ID",
    );
    expect(manualSlackStep).toBeDefined();
    expect(manualSlackStep?.message).toBeTruthy();

    const found = await prisma.agent.findUnique({
      where: { id: AGENT_ID },
      include: { envVars: true },
    });
    expect(found).toBeNull();
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe("deleteAgentFully — edge cases", () => {
  it("throws a clear error when the agent does not exist", async () => {
    const prisma = fakePrisma([], []);
    const deps: AgentDeletionDeps = {
      prisma,
      provisioner: fakeProvisioner(),
      taskStoreClient: fakeTaskStoreClient(),
      chatServiceClient: fakeChatServiceClient(),
      slackClient: fakeSlackClient(),
    };

    await expect(deleteAgentFully("does-not-exist", deps)).rejects.toThrow();
  });

  it("handles an agent with no AgentEnv rows (empty checklist, slack step skipped)", async () => {
    const agents: FakeAgentRow[] = [{ id: AGENT_ID, name: "my-agent" }];
    const prisma = fakePrisma(agents, []);
    const deps: AgentDeletionDeps = {
      prisma,
      provisioner: fakeProvisioner(),
      taskStoreClient: fakeTaskStoreClient(),
      chatServiceClient: fakeChatServiceClient(),
      slackClient: fakeSlackClient(),
    };

    const result = await deleteAgentFully(AGENT_ID, deps);

    expect(result.agentDeleted).toBe(true);
    expect(result.manualStepsRequired).toEqual([]);
    expect(result.completed).not.toContain("slack");
  });

  it("collects multiple independent failures without one masking the other", async () => {
    const agents: FakeAgentRow[] = [{ id: AGENT_ID, name: "my-agent" }];
    const prisma = fakePrisma(agents, []);

    const provisioner = fakeProvisioner({
      deprovision: async () => {
        throw new Error("k8s failure");
      },
    });
    const taskStoreClient = fakeTaskStoreClient({
      revokeToken: async () => {
        throw new Error("task-store failure");
      },
    });

    const deps: AgentDeletionDeps = {
      prisma,
      provisioner,
      taskStoreClient,
      chatServiceClient: fakeChatServiceClient(),
      slackClient: fakeSlackClient(),
    };

    const result = await deleteAgentFully(AGENT_ID, deps);

    expect(result.agentDeleted).toBe(false);
    const steps = result.failed.map((f) => f.step).sort();
    expect(steps).toEqual(["k8s", "task-store"]);
  });
});
