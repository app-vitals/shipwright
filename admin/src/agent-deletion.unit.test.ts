/**
 * admin/src/agent-deletion.unit.test.ts
 *
 * Unit tests for deleteAgentFully() — the shared agent-deletion orchestration.
 * All dependencies (Prisma, provisioner, task-store, chat-service, Slack) are
 * injected in-memory doubles: no real DB, no network. Per this repo's isolation
 * contract — no mock.module(), no global overrides.
 */

import { describe, expect, it } from "bun:test";
import {
  type DeleteAgentFullyDeps,
  deleteAgentFully,
} from "./agent-deletion.ts";
import { NotFoundError } from "./errors.ts";

// ─── In-memory doubles ──────────────────────────────────────────────────────

interface EnvRow {
  key: string;
  value: string;
  secret: boolean;
}

/** Minimal in-memory Prisma double tracking whether the Agent row exists. */
class FakePrisma {
  deleted = false;
  constructor(
    private readonly row: { id: string; name: string } | null,
    private readonly envRows: EnvRow[] = [],
  ) {}

  agent = {
    findUnique: async (_args: {
      where: { id: string };
      select: { id: true; name: true };
    }): Promise<{ id: string; name: string } | null> => {
      if (this.deleted || !this.row) return null;
      return { id: this.row.id, name: this.row.name };
    },
    delete: async (_args: { where: { id: string } }): Promise<unknown> => {
      this.deleted = true;
      return {};
    },
  };

  agentEnv = {
    findMany: async (_args: {
      where: { agentId: string };
      select: { key: true; value: true; secret: true };
    }): Promise<EnvRow[]> => this.envRows,
  };
}

interface CallLog {
  deprovision: string[];
  tsListed: string[];
  tsRevoked: string[];
  csListed: string[];
  csRevoked: string[];
  threadsDeleted: string[];
  slackDeleted: Array<{ token: string; appId: string }>;
}

function makeDeps(opts: {
  prisma: FakePrisma;
  envRows?: EnvRow[];
  tsTokens?: { id: string }[];
  csTokens?: { id: string }[];
  fail?: Partial<{
    deprovision: Error;
    tsRevoke: Error;
    csRevoke: Error;
    threads: Error;
    slack: Error;
  }>;
}): { deps: DeleteAgentFullyDeps; log: CallLog } {
  const log: CallLog = {
    deprovision: [],
    tsListed: [],
    tsRevoked: [],
    csListed: [],
    csRevoked: [],
    threadsDeleted: [],
    slackDeleted: [],
  };

  const deps: DeleteAgentFullyDeps = {
    prisma: opts.prisma,
    provisioner: {
      deprovision: async (agentId, _o) => {
        log.deprovision.push(agentId);
        if (opts.fail?.deprovision) throw opts.fail.deprovision;
      },
    },
    taskStore: {
      listTokensForAgent: async (agentId) => {
        log.tsListed.push(agentId);
        return opts.tsTokens ?? [];
      },
      revokeToken: async (id) => {
        log.tsRevoked.push(id);
        if (opts.fail?.tsRevoke) throw opts.fail.tsRevoke;
      },
    },
    chatService: {
      listTokensForAgent: async (agentId) => {
        log.csListed.push(agentId);
        return opts.csTokens ?? [];
      },
      revokeToken: async (id) => {
        log.csRevoked.push(id);
        if (opts.fail?.csRevoke) throw opts.fail.csRevoke;
      },
      deleteThreadsForAgent: async (agentId) => {
        log.threadsDeleted.push(agentId);
        if (opts.fail?.threads) throw opts.fail.threads;
        return { deleted: 0 };
      },
    },
    slack: {
      deleteApp: async (token, appId) => {
        log.slackDeleted.push({ token, appId });
        if (opts.fail?.slack) throw opts.fail.slack;
      },
    },
    // Identity decrypt: env values in these tests are stored "plaintext".
    decrypt: (value) => value,
  };

  return { deps, log };
}

const AGENT = { id: "agent-1", name: "dude-bot" };

// ─── AC1: Happy path ─────────────────────────────────────────────────────────

describe("deleteAgentFully — happy path", () => {
  it("runs every automated step, deletes the Agent row, and returns agentDeleted: true", async () => {
    const envRows: EnvRow[] = [
      { key: "SLACK_APP_ID", value: "A123", secret: true },
      { key: "GH_TOKEN", value: "ghp_x", secret: true },
      { key: "PORT", value: "3000", secret: false },
    ];
    const prisma = new FakePrisma(AGENT, envRows);
    const { deps, log } = makeDeps({
      prisma,
      tsTokens: [{ id: "ts-1" }],
      csTokens: [{ id: "cs-1" }],
    });

    const result = await deleteAgentFully(AGENT.id, deps, {
      xoxpToken: "xoxp-user",
    });

    expect(result.agentDeleted).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.completed).toEqual([
      "k8s",
      "task-store-tokens",
      "chat-service-tokens-and-threads",
      "slack-app",
    ]);
    // Agent row actually deleted.
    expect(prisma.deleted).toBe(true);
    // Each dependency was actually driven.
    expect(log.deprovision).toEqual([AGENT.id]);
    expect(log.tsRevoked).toEqual(["ts-1"]);
    expect(log.csRevoked).toEqual(["cs-1"]);
    expect(log.threadsDeleted).toEqual([AGENT.id]);
    expect(log.slackDeleted).toEqual([{ token: "xoxp-user", appId: "A123" }]);
    // Checklist contains the manual GH_TOKEN reminder; Slack was auto-deleted
    // so it is NOT in the manual list; non-secret PORT is excluded.
    const keys = result.manualStepsRequired.map((s) => s.key);
    expect(keys).toEqual(["GH_TOKEN"]);
  });

  it("omits the slack-app step entirely when no SLACK_APP_ID is set", async () => {
    const prisma = new FakePrisma(AGENT, [
      { key: "GH_TOKEN", value: "ghp_x", secret: true },
    ]);
    const { deps, log } = makeDeps({ prisma });

    const result = await deleteAgentFully(AGENT.id, deps, {
      xoxpToken: "xoxp-user",
    });

    expect(result.agentDeleted).toBe(true);
    expect(result.completed).not.toContain("slack-app");
    expect(log.slackDeleted).toEqual([]);
    expect(result.manualStepsRequired.map((s) => s.key)).toEqual(["GH_TOKEN"]);
  });
});

// ─── AC2: Partial failure ────────────────────────────────────────────────────

describe("deleteAgentFully — partial failure", () => {
  it("does not delete the Agent row, records the failed step, and still runs the others", async () => {
    const prisma = new FakePrisma(AGENT, []);
    const { deps, log } = makeDeps({
      prisma,
      tsTokens: [{ id: "ts-1" }],
      fail: { tsRevoke: new Error("task-store down") },
    });

    const result = await deleteAgentFully(AGENT.id, deps);

    expect(result.agentDeleted).toBe(false);
    // Agent row still present.
    expect(prisma.deleted).toBe(false);
    // The failing step is captured with its message.
    expect(result.failed).toEqual([
      { step: "task-store-tokens", error: "task-store down" },
    ]);
    // Other steps still ran (not skipped) — K8s + chat-service completed.
    expect(result.completed).toContain("k8s");
    expect(result.completed).toContain("chat-service-tokens-and-threads");
    expect(log.deprovision).toEqual([AGENT.id]);
    expect(log.threadsDeleted).toEqual([AGENT.id]);
  });

  it("attempts every token in a step even if one revoke throws, then records the step failed", async () => {
    const prisma = new FakePrisma(AGENT, []);
    const { deps, log } = makeDeps({
      prisma,
      tsTokens: [{ id: "ts-1" }, { id: "ts-2" }],
      fail: { tsRevoke: new Error("boom") },
    });

    const result = await deleteAgentFully(AGENT.id, deps);

    // Both tokens were attempted despite the first throwing.
    expect(log.tsRevoked).toEqual(["ts-1", "ts-2"]);
    expect(result.failed[0].step).toBe("task-store-tokens");
    expect(result.agentDeleted).toBe(false);
  });
});

// ─── AC3: Retry after partial failure ────────────────────────────────────────

describe("deleteAgentFully — retry", () => {
  it("completes remaining steps and deletes the row on a second, healthy call", async () => {
    const prisma = new FakePrisma(AGENT, []);

    // First call: task-store revoke fails.
    const first = makeDeps({
      prisma,
      tsTokens: [{ id: "ts-1" }],
      fail: { tsRevoke: new Error("task-store down") },
    });
    const r1 = await deleteAgentFully(AGENT.id, first.deps);
    expect(r1.agentDeleted).toBe(false);
    expect(prisma.deleted).toBe(false);

    // Second call: dependency healthy again; underlying steps are idempotent
    // (K8s already gone, token already effectively revoked) — no errors on
    // re-run, and this time the row is deleted.
    const second = makeDeps({ prisma, tsTokens: [{ id: "ts-1" }] });
    const r2 = await deleteAgentFully(AGENT.id, second.deps);

    expect(r2.agentDeleted).toBe(true);
    expect(r2.failed).toEqual([]);
    expect(prisma.deleted).toBe(true);
    // Re-running already-completed steps didn't error.
    expect(second.log.deprovision).toEqual([AGENT.id]);
    expect(second.log.tsRevoked).toEqual(["ts-1"]);
  });
});

// ─── AC4: Slack app present but no token supplied ────────────────────────────

describe("deleteAgentFully — Slack app without a token", () => {
  it("adds a manual Slack checklist entry and does NOT mark agentDeleted: false", async () => {
    const prisma = new FakePrisma(AGENT, [
      { key: "SLACK_APP_ID", value: "A999", secret: true },
    ]);
    const { deps, log } = makeDeps({ prisma });

    // No xoxpToken supplied.
    const result = await deleteAgentFully(AGENT.id, deps);

    expect(result.agentDeleted).toBe(true);
    expect(prisma.deleted).toBe(true);
    expect(log.slackDeleted).toEqual([]);
    expect(result.completed).not.toContain("slack-app");
    expect(result.failed).toEqual([]);

    const slackStep = result.manualStepsRequired.find(
      (s) => s.key === "SLACK_APP_ID",
    );
    expect(slackStep).toBeDefined();
    expect(slackStep?.message).toContain("A999");
    expect(slackStep?.message).toContain("no Slack user token was supplied");
  });

  it("records slack-app as failed (row not deleted) when a token IS supplied but the delete throws", async () => {
    const prisma = new FakePrisma(AGENT, [
      { key: "SLACK_APP_ID", value: "A999", secret: true },
    ]);
    const { deps } = makeDeps({
      prisma,
      fail: { slack: new Error("slack rejected") },
    });

    const result = await deleteAgentFully(AGENT.id, deps, {
      xoxpToken: "xoxp-user",
    });

    expect(result.agentDeleted).toBe(false);
    expect(prisma.deleted).toBe(false);
    expect(result.failed).toEqual([
      { step: "slack-app", error: "slack rejected" },
    ]);
  });
});

// ─── Edge: unknown agent ─────────────────────────────────────────────────────

describe("deleteAgentFully — unknown agent", () => {
  it("throws NotFoundError when the Agent row is absent", async () => {
    const prisma = new FakePrisma(null);
    const { deps } = makeDeps({ prisma });

    await expect(deleteAgentFully("nope", deps)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
