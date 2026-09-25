/**
 * admin/src/trial-expiry-sweeper.integration.test.ts
 * Integration tests for TrialExpiryWarningSweeper (ATE-2.1) against fixture
 * Agent rows via an injected *PrismaLike double, an injected AgentService
 * double (for the trialExpiryWarnedAt write), an injected AgentEnvService
 * double (for the per-agent SLACK_BOT_TOKEN/SLACK_ALERT_CHANNEL lookup), an
 * injected Slack-sending double, and a FixedClock. No mock.module(), no
 * global.fetch override, no real Slack call — per the repo's hard
 * test-isolation rule (CLAUDE.md).
 */

import { describe, expect, it, mock } from "bun:test";
import { WebClient } from "@slack/web-api";
import { FixedClock } from "./clock.ts";
import {
  defaultSlackClientFactory,
  type SlackPostMessageClient,
  sendTrialExpiryWarning,
  type TrialExpiryAgentRow,
  type TrialExpiryPrismaLike,
  type TrialExpirySweeperDeps,
  TrialExpiryWarningSweeper,
} from "./trial-expiry-sweeper.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-25T12:00:00.000Z");

function daysFromNow(days: number): Date {
  return new Date(NOW.getTime() + days * DAY_MS);
}

// ─── Doubles ────────────────────────────────────────────────────────────────

interface FakeAgentRow extends TrialExpiryAgentRow {
  slackBotToken?: string;
  slackAlertChannel?: string;
}

function fakePrisma(agents: FakeAgentRow[]): TrialExpiryPrismaLike {
  return {
    agent: {
      // Mirrors a real `WHERE "trialExpiresAt" IS NOT NULL AND
      // "trialExpiryWarnedAt" IS NULL` — the two dedup/eligibility filters
      // ATE-1.1 agents (unset trialExpiresAt) and already-warned agents rely
      // on the sweeper never even seeing them.
      findMany: async () =>
        agents
          .filter((a) => a.trialExpiresAt !== null)
          .filter((a) => a.trialExpiryWarnedAt === null)
          .map(({ id, name, trialExpiresAt, trialExpiryWarnedAt }) => ({
            id,
            name,
            trialExpiresAt,
            trialExpiryWarnedAt,
          })),
    },
  };
}

interface RecordedSend {
  agentId: string;
  botToken: string;
  channel: string;
  text: string;
}

function buildDeps(
  agents: FakeAgentRow[],
  overrides: {
    sendResult?: (agentId: string) => boolean;
  } = {},
): TrialExpirySweeperDeps & {
  sends: RecordedSend[];
  agents: FakeAgentRow[];
} {
  const sends: RecordedSend[] = [];
  const byId = new Map(agents.map((a) => [a.id, a]));

  const agentService: TrialExpirySweeperDeps["agentService"] = {
    updateFields: async (id, input) => {
      const agent = byId.get(id);
      if (!agent) throw new Error(`unknown agent ${id}`);
      if (input.trialExpiryWarnedAt !== undefined) {
        agent.trialExpiryWarnedAt = input.trialExpiryWarnedAt;
      }
      return {
        id: agent.id,
        name: agent.name,
        slackId: null,
        selfHosted: false,
        typeName: "coding",
        createdAt: NOW,
        updatedAt: NOW,
        missingRequiredEnv: [],
      } as never;
    },
  };

  const agentEnvService: TrialExpirySweeperDeps["agentEnvService"] = {
    getConfigBundle: async (agentId) => {
      const agent = byId.get(agentId);
      if (!agent || (!agent.slackBotToken && !agent.slackAlertChannel)) {
        return null;
      }
      const env: Record<string, string> = {};
      if (agent.slackBotToken) env.SLACK_BOT_TOKEN = agent.slackBotToken;
      if (agent.slackAlertChannel)
        env.SLACK_ALERT_CHANNEL = agent.slackAlertChannel;
      return { env, agentId, allowedTools: [] };
    },
  };

  const sendSlackMessage: TrialExpirySweeperDeps["sendSlackMessage"] = async (
    params,
  ) => {
    // agentId isn't part of the wire params (the real WebClient call doesn't
    // need one), but tests need to correlate sends back to a fixture agent —
    // recover it from the channel/token pairing set up per-fixture below.
    const agent = agents.find(
      (a) =>
        a.slackBotToken === params.botToken &&
        a.slackAlertChannel === params.channel,
    );
    sends.push({
      agentId: agent?.id ?? "unknown",
      botToken: params.botToken,
      channel: params.channel,
      text: params.text,
    });
    return overrides.sendResult ? overrides.sendResult(agent?.id ?? "") : true;
  };

  return {
    prisma: fakePrisma(agents),
    agentService,
    agentEnvService,
    sendSlackMessage,
    clock: FixedClock(NOW),
    sends,
    agents,
  };
}

function makeAgent(
  overrides: Partial<FakeAgentRow> & { id: string },
): FakeAgentRow {
  return {
    name: overrides.id,
    trialExpiresAt: null,
    trialExpiryWarnedAt: null,
    // Unique per agent (not a shared constant) so the sendSlackMessage
    // double below can correlate a recorded send back to the fixture agent
    // that triggered it, purely a test-correlation concern.
    slackBotToken: `xoxb-fake-token-${overrides.id}`,
    slackAlertChannel: `#alerts-${overrides.id}`,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("TrialExpiryWarningSweeper", () => {
  it("sends exactly one Slack alert for an agent 2 days from expiry with a 3-day window (AC1)", async () => {
    const agentA = makeAgent({ id: "agent-a", trialExpiresAt: daysFromNow(2) });
    const deps = buildDeps([agentA]);
    const sweeper = new TrialExpiryWarningSweeper(deps);

    const result = await sweeper.tick();

    expect(deps.sends).toHaveLength(1);
    expect(deps.sends[0].agentId).toBe("agent-a");
    expect(deps.sends[0].text).toContain(
      (agentA.trialExpiresAt as Date).toISOString().slice(0, 10),
    );
    expect(result.warned).toBe(1);
    expect(agentA.trialExpiryWarnedAt).toEqual(NOW);
  });

  it("does not send a second alert for the same agent on a re-run (AC2, dedup via trialExpiryWarnedAt)", async () => {
    const agentA = makeAgent({ id: "agent-a", trialExpiresAt: daysFromNow(2) });
    const deps = buildDeps([agentA]);
    const sweeper = new TrialExpiryWarningSweeper(deps);

    await sweeper.tick();
    expect(deps.sends).toHaveLength(1);

    // Re-run against the same fixture store (trialExpiryWarnedAt now set by
    // the previous tick — the sweeper's own findMany-equivalent filter must
    // exclude it, exactly like a real `WHERE trialExpiryWarnedAt IS NULL`).
    const result2 = await sweeper.tick();

    expect(deps.sends).toHaveLength(1);
    expect(result2.warned).toBe(0);
  });

  it("never considers an agent with trialExpiresAt unset (AC3)", async () => {
    const untouched = makeAgent({
      id: "agent-untouched",
      trialExpiresAt: null,
    });
    const dueSoon = makeAgent({
      id: "agent-due",
      trialExpiresAt: daysFromNow(1),
    });
    const deps = buildDeps([untouched, dueSoon]);
    const sweeper = new TrialExpiryWarningSweeper(deps);

    const result = await sweeper.tick();

    expect(deps.sends).toHaveLength(1);
    expect(deps.sends[0].agentId).toBe("agent-due");
    expect(result.warned).toBe(1);
    expect(untouched.trialExpiryWarnedAt).toBeNull();
  });

  it("skips (and does not stamp) an agent missing SLACK_BOT_TOKEN or SLACK_ALERT_CHANNEL", async () => {
    const noToken = makeAgent({
      id: "agent-no-token",
      trialExpiresAt: daysFromNow(1),
      slackBotToken: undefined,
    });
    const noChannel = makeAgent({
      id: "agent-no-channel",
      trialExpiresAt: daysFromNow(1),
      slackAlertChannel: undefined,
    });
    const deps = buildDeps([noToken, noChannel]);
    const sweeper = new TrialExpiryWarningSweeper(deps);

    const result = await sweeper.tick();

    expect(deps.sends).toHaveLength(0);
    expect(result.warned).toBe(0);
    expect(result.skipped).toBe(2);
    expect(noToken.trialExpiryWarnedAt).toBeNull();
    expect(noChannel.trialExpiryWarnedAt).toBeNull();
  });

  it("does not stamp trialExpiryWarnedAt when the Slack send fails, so the next tick retries", async () => {
    const agentA = makeAgent({ id: "agent-a", trialExpiresAt: daysFromNow(1) });
    const deps = buildDeps([agentA], { sendResult: () => false });
    const sweeper = new TrialExpiryWarningSweeper(deps);

    const result = await sweeper.tick();

    expect(deps.sends).toHaveLength(1);
    expect(result.warned).toBe(0);
    expect(result.failed).toBe(1);
    expect(agentA.trialExpiryWarnedAt).toBeNull();
  });

  it("does not warn a trial that lapsed further back than the grace window", async () => {
    // trialExpiresAt is admin-settable to any past date (PATCH /agents/:id
    // applies no future-only validation), so without the grace bound the
    // first tick after deploy would alert every long-lapsed trial at once.
    const longLapsed = makeAgent({
      id: "agent-long-lapsed",
      trialExpiresAt: daysFromNow(-90),
    });
    const recentlyLapsed = makeAgent({
      id: "agent-recently-lapsed",
      trialExpiresAt: daysFromNow(-1),
    });
    const deps = buildDeps([longLapsed, recentlyLapsed]);
    const sweeper = new TrialExpiryWarningSweeper(deps);

    const result = await sweeper.tick();

    expect(deps.sends.map((s) => s.agentId)).toEqual(["agent-recently-lapsed"]);
    expect(result.warned).toBe(1);
    expect(result.stale).toBe(1);
    expect(longLapsed.trialExpiryWarnedAt).toBeNull();
    // A grace-window alert reads in the past tense.
    expect(deps.sends[0].text).toContain("expired on");
  });

  it("honours a custom graceDays wider than the warning window", async () => {
    const lapsed = makeAgent({
      id: "agent-lapsed",
      trialExpiresAt: daysFromNow(-10),
    });
    const deps = buildDeps([lapsed]);
    const sweeper = new TrialExpiryWarningSweeper({ ...deps, graceDays: 14 });

    const result = await sweeper.tick();

    expect(result.warned).toBe(1);
    expect(result.stale).toBe(0);
  });

  it("ignores an agent whose expiry is outside the warning window", async () => {
    const farOut = makeAgent({
      id: "agent-far",
      trialExpiresAt: daysFromNow(30),
    });
    const deps = buildDeps([farOut]);
    const sweeper = new TrialExpiryWarningSweeper(deps);

    const result = await sweeper.tick();

    expect(deps.sends).toHaveLength(0);
    expect(result.warned).toBe(0);
    expect(farOut.trialExpiryWarnedAt).toBeNull();
  });

  it("handles multiple fixture agents in one sweep independently", async () => {
    const dueA = makeAgent({
      id: "agent-due-a",
      trialExpiresAt: daysFromNow(1),
    });
    const dueB = makeAgent({
      id: "agent-due-b",
      trialExpiresAt: daysFromNow(3),
    });
    const notDue = makeAgent({
      id: "agent-not-due",
      trialExpiresAt: daysFromNow(10),
    });
    const unset = makeAgent({ id: "agent-unset", trialExpiresAt: null });
    const deps = buildDeps([dueA, dueB, notDue, unset]);
    const sweeper = new TrialExpiryWarningSweeper(deps);

    const result = await sweeper.tick();

    expect(result.warned).toBe(2);
    expect(deps.sends.map((s) => s.agentId).sort()).toEqual([
      "agent-due-a",
      "agent-due-b",
    ]);
    expect(dueA.trialExpiryWarnedAt).toEqual(NOW);
    expect(dueB.trialExpiryWarnedAt).toEqual(NOW);
    expect(notDue.trialExpiryWarnedAt).toBeNull();
    expect(unset.trialExpiryWarnedAt).toBeNull();
  });

  it("respects a custom warningDays option", async () => {
    const agentA = makeAgent({ id: "agent-a", trialExpiresAt: daysFromNow(6) });
    const deps = buildDeps([agentA]);
    const sweeper = new TrialExpiryWarningSweeper({ ...deps, warningDays: 7 });

    const result = await sweeper.tick();

    expect(result.warned).toBe(1);
    expect(deps.sends).toHaveLength(1);
  });

  it("does not overlap ticks — an in-flight tick returns an all-zero result for a concurrent call", async () => {
    const agentA = makeAgent({ id: "agent-a", trialExpiresAt: daysFromNow(1) });
    const deps = buildDeps([agentA]);
    let resolveFindMany: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveFindMany = resolve;
    });
    const slowPrisma: TrialExpiryPrismaLike = {
      agent: {
        findMany: async (args) => {
          await gate;
          return deps.prisma.agent.findMany(args);
        },
      },
    };
    const sweeper = new TrialExpiryWarningSweeper({
      ...deps,
      prisma: slowPrisma,
    });

    const firstTick = sweeper.tick();
    const secondTick = await sweeper.tick();
    expect(secondTick).toEqual({
      warned: 0,
      skipped: 0,
      failed: 0,
      stale: 0,
    });

    resolveFindMany?.();
    const firstResult = await firstTick;
    expect(firstResult.warned).toBe(1);
  });
});

// ─── The real @slack/web-api send path ──────────────────────────────────────

describe("sendTrialExpiryWarning", () => {
  const params = {
    botToken: "xoxb-fake-token",
    channel: "#alerts",
    text: ":warning: Trial for agent `acme-agent` expires on 2026-09-28.",
  };

  function makeSlackClient(
    behaviour: { error?: Error } = {},
  ): SlackPostMessageClient & {
    chat: { postMessage: ReturnType<typeof mock> };
  } {
    const postMessage = mock(async (_args: unknown) => {
      if (behaviour.error) throw behaviour.error;
      return { ok: true, ts: "1737000000.000100" };
    });
    return { chat: { postMessage } } as unknown as SlackPostMessageClient & {
      chat: { postMessage: ReturnType<typeof mock> };
    };
  }

  it("builds a client from the agent's own bot token and posts the message", async () => {
    const client = makeSlackClient();
    const tokensSeen: string[] = [];

    const sent = await sendTrialExpiryWarning(params, (botToken) => {
      tokensSeen.push(botToken);
      return client;
    });

    expect(sent).toBe(true);
    expect(tokensSeen).toEqual([params.botToken]);
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: params.channel,
      text: params.text,
    });
  });

  it("returns false (never throws) when chat.postMessage rejects", async () => {
    const client = makeSlackClient({
      error: new Error("An API error occurred: channel_not_found"),
    });
    const errors: unknown[][] = [];
    const originalError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      const sent = await sendTrialExpiryWarning(params, () => client);
      expect(sent).toBe(false);
    } finally {
      console.error = originalError;
    }

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    // The failure is logged, not swallowed — a persistently failing agent has
    // to stay visible in the admin service's logs (see the module header).
    expect(errors).toHaveLength(1);
    expect(String(errors[0][0])).toContain("chat.postMessage failed");
  });

  it("returns false when the client factory itself throws (bad token)", async () => {
    const originalError = console.error.bind(console);
    console.error = () => {};
    try {
      const sent = await sendTrialExpiryWarning(params, () => {
        throw new Error("invalid token");
      });
      expect(sent).toBe(false);
    } finally {
      console.error = originalError;
    }
  });

  it("defaults to a real @slack/web-api WebClient built from the bot token", async () => {
    // The default factory is the production path — assert it really returns a
    // WebClient with a callable chat.postMessage, without making a network
    // call (the doubles above cover the send/catch behaviour itself).
    const client = defaultSlackClientFactory(params.botToken);
    expect(client).toBeInstanceOf(WebClient);
    expect(typeof client.chat.postMessage).toBe("function");
  });
});
