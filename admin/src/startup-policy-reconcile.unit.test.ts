/**
 * admin/src/startup-policy-reconcile.unit.test.ts
 * Unit tests for runStartupPolicyReconcile (ACP-1.3).
 *
 * agentService, provisioner and logger are all plain injected doubles — no
 * mock.module(), no global overrides, per the repo's test-isolation rule
 * (CLAUDE.md).
 */

import { describe, expect, it } from "bun:test";
import type { AgentProvisioner, ReconcileResult } from "./agent-provisioner.ts";
import type { AgentSummary } from "./agents.ts";
import {
  managedReconcileTargets,
  runStartupPolicyReconcile,
} from "./startup-policy-reconcile.ts";

// ─── Doubles ────────────────────────────────────────────────────────────────

type ReconcileCall = {
  agents: Parameters<AgentProvisioner["reconcile"]>[0];
  opts: Parameters<AgentProvisioner["reconcile"]>[1];
};

const EMPTY_RESULT: ReconcileResult = {
  recreated: [],
  orphans: [],
  failed: [],
  updated: [],
};

function fakeProvisioner(opts: {
  canProvision: boolean;
  reconcile?: () => Promise<ReconcileResult>;
}) {
  const calls: ReconcileCall[] = [];
  const provisioner = {
    canProvision: opts.canProvision,
    async reconcile(
      agents: ReconcileCall["agents"],
      reconcileOpts: ReconcileCall["opts"],
    ) {
      calls.push({ agents, opts: reconcileOpts });
      return opts.reconcile ? opts.reconcile() : EMPTY_RESULT;
    },
  };
  return { provisioner, calls };
}

function fakeAgentService(
  agents: AgentSummary[] | (() => Promise<AgentSummary[]>),
) {
  let listCalls = 0;
  return {
    agentService: {
      async list() {
        listCalls++;
        return typeof agents === "function" ? agents() : agents;
      },
    },
    listCalls: () => listCalls,
  };
}

function recordingLogger() {
  const lines: { level: "log" | "error"; args: unknown[] }[] = [];
  return {
    logger: {
      log: (...args: unknown[]) => lines.push({ level: "log", args }),
      error: (...args: unknown[]) => lines.push({ level: "error", args }),
    },
    lines,
  };
}

function agent(overrides: Partial<AgentSummary> & { id: string }) {
  return {
    name: `${overrides.id}-slug`,
    selfHosted: false,
    typeName: "dev",
    accountId: null,
    ...overrides,
  } satisfies AgentSummary;
}

// ─── managedReconcileTargets ────────────────────────────────────────────────

describe("managedReconcileTargets", () => {
  it("drops self-hosted agents and maps name to slug", () => {
    expect(
      managedReconcileTargets([
        agent({ id: "a1", name: "alpha", accountId: "acct-1" }),
        agent({ id: "a2", selfHosted: true }),
        agent({ id: "a3", name: "gamma" }),
      ]),
    ).toEqual([
      { id: "a1", slug: "alpha", accountId: "acct-1" },
      { id: "a3", slug: "gamma", accountId: null },
    ]);
  });
});

// ─── runStartupPolicyReconcile ──────────────────────────────────────────────

describe("runStartupPolicyReconcile", () => {
  it("reconciles non-self-hosted agents with policyOnly true", async () => {
    const { agentService } = fakeAgentService([
      agent({ id: "a1", name: "alpha" }),
      agent({ id: "a2", name: "beta", selfHosted: true }),
      agent({ id: "a3", name: "gamma", accountId: "acct-3" }),
    ]);
    const { provisioner, calls } = fakeProvisioner({ canProvision: true });
    const { logger } = recordingLogger();

    await runStartupPolicyReconcile({ agentService, provisioner, logger });

    expect(calls).toEqual([
      {
        agents: [
          { id: "a1", slug: "alpha", accountId: null },
          { id: "a3", slug: "gamma", accountId: "acct-3" },
        ],
        opts: { policyOnly: true },
      },
    ]);
  });

  it("does nothing when the provisioner cannot provision", async () => {
    const { agentService, listCalls } = fakeAgentService([agent({ id: "a1" })]);
    const { provisioner, calls } = fakeProvisioner({ canProvision: false });
    const { logger, lines } = recordingLogger();

    await runStartupPolicyReconcile({ agentService, provisioner, logger });

    expect(calls).toHaveLength(0);
    expect(listCalls()).toBe(0);
    expect(lines).toHaveLength(0);
  });

  it("logs a provisioner error instead of throwing", async () => {
    const { agentService } = fakeAgentService([agent({ id: "a1" })]);
    const boom = new Error("kube api unreachable");
    const { provisioner } = fakeProvisioner({
      canProvision: true,
      reconcile: () => Promise.reject(boom),
    });
    const { logger, lines } = recordingLogger();

    await expect(
      runStartupPolicyReconcile({ agentService, provisioner, logger }),
    ).resolves.toBeUndefined();

    const errors = lines.filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.args).toContain(boom);
  });

  it("logs an agent listing error instead of throwing", async () => {
    const boom = new Error("db down");
    const { agentService } = fakeAgentService(() => Promise.reject(boom));
    const { provisioner, calls } = fakeProvisioner({ canProvision: true });
    const { logger, lines } = recordingLogger();

    await expect(
      runStartupPolicyReconcile({ agentService, provisioner, logger }),
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(0);
    const errors = lines.filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.args).toContain(boom);
  });

  it("logs the reconcile outcome on success", async () => {
    const { agentService } = fakeAgentService([agent({ id: "a1" })]);
    const { provisioner } = fakeProvisioner({
      canProvision: true,
      reconcile: async () => ({
        ...EMPTY_RESULT,
        recreated: ["a1"],
        updated: ["a2", "a3"],
        orphans: ["x9"],
      }),
    });
    const { logger, lines } = recordingLogger();

    await runStartupPolicyReconcile({ agentService, provisioner, logger });

    expect(lines.filter((l) => l.level === "error")).toHaveLength(0);
    const text = lines.map((l) => l.args.join(" ")).join("\n");
    expect(text).toContain("updated=2");
    expect(text).toContain("recreated=1");
    expect(text).toContain("orphans=1");
  });

  it("logs per-agent failures from the reconcile result as errors", async () => {
    const { agentService } = fakeAgentService([agent({ id: "a1" })]);
    const { provisioner } = fakeProvisioner({
      canProvision: true,
      reconcile: async () => ({
        ...EMPTY_RESULT,
        failed: [{ agentId: "a1", error: "patch rejected" }],
      }),
    });
    const { logger, lines } = recordingLogger();

    await runStartupPolicyReconcile({ agentService, provisioner, logger });

    const errors = lines
      .filter((l) => l.level === "error")
      .map((l) => l.args.join(" "));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("a1");
    expect(errors[0]).toContain("patch rejected");
  });
});
