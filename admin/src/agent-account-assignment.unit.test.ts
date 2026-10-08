import { describe, expect, it } from "bun:test";
import { reconcileAgentAfterAccountChange } from "./agent-account-assignment.ts";

interface Result {
  recreated: string[];
  orphans: string[];
  failed: Array<{ agentId: string; error: string }>;
  updated: string[];
}
const EMPTY: Result = { recreated: [], orphans: [], failed: [], updated: [] };

function makeProvisioner(
  impl: (agents: unknown[]) => Promise<Result> = async () => EMPTY,
) {
  const calls: unknown[][] = [];
  return {
    calls,
    reconcile: async (agents: unknown[]) => {
      calls.push(agents);
      return impl(agents);
    },
  };
}

const agent = { id: "a1", name: "Bot", selfHosted: false, accountId: "acct" };

describe("reconcileAgentAfterAccountChange", () => {
  it("reconciles exactly the one in-cluster agent with its new accountId", async () => {
    const p = makeProvisioner();
    expect(await reconcileAgentAfterAccountChange(p, agent)).toBeUndefined();
    expect(p.calls).toEqual([[{ id: "a1", slug: "Bot", accountId: "acct" }]]);
  });

  it("passes null for a cleared account", async () => {
    const p = makeProvisioner();
    await reconcileAgentAfterAccountChange(p, { ...agent, accountId: null });
    expect(p.calls).toEqual([[{ id: "a1", slug: "Bot", accountId: null }]]);
  });

  it("skips self-hosted agents", async () => {
    const p = makeProvisioner();
    await reconcileAgentAfterAccountChange(p, { ...agent, selfHosted: true });
    expect(p.calls).toEqual([]);
  });

  it("returns a warning when reconcile reports a failure for the agent", async () => {
    const p = makeProvisioner(async () => ({
      ...EMPTY,
      failed: [{ agentId: "a1", error: "k8s down" }],
    }));
    expect(await reconcileAgentAfterAccountChange(p, agent)).toContain(
      "k8s down",
    );
  });

  it("returns a warning instead of throwing when reconcile throws", async () => {
    const p = makeProvisioner(async () => {
      throw new Error("boom");
    });
    expect(await reconcileAgentAfterAccountChange(p, agent)).toContain("boom");
  });
});
