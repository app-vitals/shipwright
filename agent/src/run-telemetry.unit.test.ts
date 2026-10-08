import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "./progress-milestones.ts";
import { RunTelemetryAccumulator } from "./run-telemetry.ts";

const MODEL = "claude-sonnet-4-6";

function usage(
  input: number,
  output: number,
  cacheRead = 0,
  cacheCreation = 0,
) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  };
}

function skillBlock(id: string, skill: string): ContentBlock {
  return {
    type: "tool_use",
    id,
    name: "Skill",
    input: { skill },
  } as ContentBlock;
}

function agentBlock(id: string, subagentType: string): ContentBlock {
  return {
    type: "tool_use",
    id,
    name: "Agent",
    input: { subagent_type: subagentType, prompt: "go" },
  } as ContentBlock;
}

function readBlock(id: string): ContentBlock {
  return { type: "tool_use", id, name: "Read", input: {} } as ContentBlock;
}

describe("RunTelemetryAccumulator — first-turn baseline", () => {
  test("captures the first usage-bearing turn and sums all three input kinds", () => {
    const acc = new RunTelemetryAccumulator();
    acc.observeUsage("msg_1", MODEL, usage(2, 297, 37_771, 41_415));
    acc.observeUsage("msg_2", MODEL, usage(500, 10, 79_000, 600));

    const snap = acc.snapshot();
    expect(snap.firstTurn).toEqual({
      model: MODEL,
      messageId: "msg_1",
      inputTokens: 2,
      cacheCreationTokens: 41_415,
      cacheReadTokens: 37_771,
      contextTokens: 2 + 41_415 + 37_771,
    });
    expect(snap.turns).toBe(2);
  });

  test("a sub-agent turn never becomes the first-turn baseline", () => {
    const acc = new RunTelemetryAccumulator();
    acc.observeContent([agentBlock("tu_agent", "Explore")]);
    acc.observeUsage("sub_1", MODEL, usage(50, 5), "tu_agent");
    acc.observeUsage("msg_1", MODEL, usage(1, 1, 100, 200));

    expect(acc.snapshot().firstTurn?.messageId).toBe("msg_1");
  });

  test("snapshot of an empty run has no firstTurn, zero counts, and no rows", () => {
    expect(new RunTelemetryAccumulator().snapshot()).toEqual({
      turns: 0,
      toolCalls: 0,
      skillUsage: [],
    });
  });
});

describe("RunTelemetryAccumulator — tool calls", () => {
  test("counts distinct tool_use ids across repeated lines of the same message", () => {
    const acc = new RunTelemetryAccumulator();
    acc.observeContent([readBlock("tu_1")]);
    acc.observeContent([readBlock("tu_1"), readBlock("tu_2")]);
    acc.observeContent(undefined);
    acc.observeContent([{ type: "text", text: "hi" } as ContentBlock]);

    expect(acc.toolCalls).toBe(2);
    expect(acc.snapshot().toolCalls).toBe(2);
  });
});

describe("RunTelemetryAccumulator — skill attribution", () => {
  test("turns before any invoke accrue to root; later turns to the last invoked skill", () => {
    const acc = new RunTelemetryAccumulator();
    acc.observeUsage("msg_1", MODEL, usage(10, 1));
    acc.observeContent([skillBlock("tu_skill", "shipwright:task-store")]);
    acc.observeUsage("msg_2", MODEL, usage(20, 2, 0, 9_000));
    acc.observeUsage("msg_3", MODEL, usage(30, 3));

    const rows = acc.snapshot().skillUsage;
    expect(rows).toEqual([
      {
        kind: "root",
        name: "root",
        invocations: 0,
        turns: 1,
        inputTokens: 10,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        invokeContextDelta: null,
      },
      {
        kind: "skill",
        name: "shipwright:task-store",
        invocations: 1,
        turns: 2,
        inputTokens: 50,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 9_000,
        invokeContextDelta: 20 + 9_000,
      },
    ]);
  });

  test("a second invoke of the same skill counts as an invocation but keeps the first delta", () => {
    const acc = new RunTelemetryAccumulator();
    acc.observeContent([skillBlock("tu_a", "shipwright:review")]);
    acc.observeUsage("msg_1", MODEL, usage(5, 1, 0, 100));
    acc.observeContent([skillBlock("tu_b", "shipwright:review")]);
    acc.observeUsage("msg_2", MODEL, usage(5, 1, 0, 999));

    const [row] = acc.snapshot().skillUsage;
    expect(row.name).toBe("shipwright:review");
    expect(row.invocations).toBe(2);
    expect(row.turns).toBe(2);
    expect(row.invokeContextDelta).toBe(105);
  });

  test("a skill invoked with no usage-bearing turn afterwards has a null delta", () => {
    const acc = new RunTelemetryAccumulator();
    acc.observeContent([skillBlock("tu_a", "shipwright:deploy")]);
    const [row] = acc.snapshot().skillUsage;
    expect(row.invocations).toBe(1);
    expect(row.turns).toBe(0);
    expect(row.invokeContextDelta).toBeNull();
  });

  test("a Skill block without a skill name is counted as a tool call but not attributed", () => {
    const acc = new RunTelemetryAccumulator();
    acc.observeContent([
      {
        type: "tool_use",
        id: "tu_x",
        name: "Skill",
        input: {},
      } as ContentBlock,
    ]);
    acc.observeUsage("msg_1", MODEL, usage(1, 1));
    const snap = acc.snapshot();
    expect(snap.toolCalls).toBe(1);
    expect(snap.skillUsage.map((r) => r.kind)).toEqual(["root"]);
  });

  test("switching skills charges later turns to the newest invoke only", () => {
    const acc = new RunTelemetryAccumulator();
    acc.observeContent([skillBlock("tu_a", "a")]);
    acc.observeUsage("msg_1", MODEL, usage(1, 1));
    acc.observeContent([skillBlock("tu_b", "b")]);
    acc.observeUsage("msg_2", MODEL, usage(2, 2));
    acc.observeUsage("msg_3", MODEL, usage(3, 3));

    const byName = Object.fromEntries(
      acc.snapshot().skillUsage.map((r) => [r.name, r]),
    );
    expect(byName.a.turns).toBe(1);
    expect(byName.b.turns).toBe(2);
    expect(byName.b.inputTokens).toBe(5);
  });
});

describe("RunTelemetryAccumulator — sub-agent attribution", () => {
  test("turns carrying parent_tool_use_id go to agent:<type> and leave the current skill alone", () => {
    const acc = new RunTelemetryAccumulator();
    acc.observeContent([skillBlock("tu_skill", "shipwright:patch")]);
    acc.observeContent([agentBlock("tu_agent", "shipwright:code-reviewer")]);
    acc.observeUsage("sub_1", MODEL, usage(100, 10), "tu_agent");
    acc.observeUsage("sub_2", MODEL, usage(100, 10), "tu_agent");
    acc.observeUsage("msg_2", MODEL, usage(7, 1, 0, 50));

    const byKey = Object.fromEntries(
      acc.snapshot().skillUsage.map((r) => [`${r.kind}:${r.name}`, r]),
    );
    expect(byKey["agent:shipwright:code-reviewer"]).toMatchObject({
      invocations: 1,
      turns: 2,
      inputTokens: 200,
      invokeContextDelta: null,
    });
    expect(byKey["skill:shipwright:patch"]).toMatchObject({
      turns: 1,
      inputTokens: 7,
      invokeContextDelta: 57,
    });
    expect(acc.snapshot().turns).toBe(3);
  });

  test("a sub-agent turn whose parent tool_use was never seen lands in agent:unknown", () => {
    const acc = new RunTelemetryAccumulator();
    acc.observeUsage("sub_1", MODEL, usage(1, 1), "tu_missing");
    expect(acc.snapshot().skillUsage).toEqual([
      expect.objectContaining({ kind: "agent", name: "unknown", turns: 1 }),
    ]);
  });
});
