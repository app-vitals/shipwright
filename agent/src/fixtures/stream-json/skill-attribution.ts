/**
 * Hand-authored synthetic `claude -p --output-format stream-json --verbose`
 * transcript exercising `agent/src/run-telemetry.ts` end-to-end through
 * `_consumeStream`: first-turn baseline capture, turn/tool-call counting, and
 * per-skill attribution with a sub-agent turn in the middle.
 *
 * NOTE: hand-authored per the documented public Claude Code CLI stream-json
 * schema (the same shapes the fixtures beside this one use). Numbers are
 * chosen so each attribution bucket's totals are distinct and checkable.
 *
 * Shape of the session:
 *  - one `system`/`init` line
 *  - `msg_1` (root): text only, usage = the first-turn baseline
 *  - `msg_2` (root): a `Skill` tool_use invoking "shipwright:task-store"
 *    — emitted twice with the same message id (dedupe), the second line
 *    carrying the usage
 *  - a `user` tool_result line (no usage)
 *  - `msg_3` (skill): first usage-bearing turn after the invoke — its
 *    input + cache_creation is the skill's invokeContextDelta; it also fires
 *    an `Agent` tool_use (subagent_type "Explore")
 *  - `sub_1` (agent): a sub-agent turn carrying `parent_tool_use_id`
 *  - `msg_4` (skill): a plain Read tool_use + usage, still charged to the skill
 *  - one terminal `result`/success line
 */

import type { RunTelemetry } from "../../run-telemetry.ts";

const SONNET = "claude-sonnet-4-6";
const SESSION_ID = "sess-skill-attribution";

export const lines: string[] = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: SESSION_ID,
    model: SONNET,
    tools: ["Read", "Skill", "Agent"],
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_1",
      role: "assistant",
      model: SONNET,
      content: [{ type: "text", text: "Starting." }],
      usage: {
        input_tokens: 2,
        output_tokens: 10,
        cache_read_input_tokens: 30_000,
        cache_creation_input_tokens: 40_000,
      },
    },
    session_id: SESSION_ID,
  }),
  // msg_2 — Skill invoke, first line has no usage yet
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_2",
      role: "assistant",
      model: SONNET,
      content: [
        {
          type: "tool_use",
          id: "tu_skill",
          name: "Skill",
          input: { skill: "shipwright:task-store" },
        },
      ],
    },
    session_id: SESSION_ID,
  }),
  // msg_2 — same message id repeated, now with usage (must count once)
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_2",
      role: "assistant",
      model: SONNET,
      content: [
        {
          type: "tool_use",
          id: "tu_skill",
          name: "Skill",
          input: { skill: "shipwright:task-store" },
        },
      ],
      usage: {
        input_tokens: 3,
        output_tokens: 20,
        cache_read_input_tokens: 70_000,
        cache_creation_input_tokens: 100,
      },
    },
    session_id: SESSION_ID,
  }),
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_skill",
          content: "<skill body>",
        },
      ],
    },
    session_id: SESSION_ID,
  }),
  // msg_3 — first turn after the invoke: cache_creation carries the skill body
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_3",
      role: "assistant",
      model: SONNET,
      content: [
        {
          type: "tool_use",
          id: "tu_agent",
          name: "Agent",
          input: { subagent_type: "Explore", prompt: "find things" },
        },
      ],
      usage: {
        input_tokens: 4,
        output_tokens: 30,
        cache_read_input_tokens: 70_100,
        cache_creation_input_tokens: 9_000,
      },
    },
    session_id: SESSION_ID,
  }),
  // sub_1 — sub-agent turn
  JSON.stringify({
    type: "assistant",
    parent_tool_use_id: "tu_agent",
    message: {
      id: "sub_1",
      role: "assistant",
      model: SONNET,
      content: [{ type: "text", text: "found it" }],
      usage: {
        input_tokens: 500,
        output_tokens: 40,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    session_id: SESSION_ID,
  }),
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_agent", content: "report" },
      ],
    },
    session_id: SESSION_ID,
  }),
  // msg_4 — still attributed to the skill
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_4",
      role: "assistant",
      model: SONNET,
      content: [{ type: "tool_use", id: "tu_read", name: "Read", input: {} }],
      usage: {
        input_tokens: 5,
        output_tokens: 50,
        cache_read_input_tokens: 79_100,
        cache_creation_input_tokens: 200,
      },
    },
    session_id: SESSION_ID,
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    result: "done",
    session_id: SESSION_ID,
    is_error: false,
    usage: {
      input_tokens: 514,
      output_tokens: 150,
      cache_read_input_tokens: 249_200,
      cache_creation_input_tokens: 49_300,
    },
    total_cost_usd: 0.42,
    modelUsage: {
      [SONNET]: {
        inputTokens: 514,
        outputTokens: 150,
        cacheReadInputTokens: 249_200,
        cacheCreationInputTokens: 49_300,
        costUSD: 0.42,
      },
    },
  }),
];

export const expectedTelemetry: RunTelemetry = {
  firstTurn: {
    model: SONNET,
    messageId: "msg_1",
    inputTokens: 2,
    cacheCreationTokens: 40_000,
    cacheReadTokens: 30_000,
    contextTokens: 70_002,
  },
  turns: 5,
  toolCalls: 3,
  skillUsage: [
    {
      kind: "root",
      name: "root",
      invocations: 0,
      turns: 1,
      inputTokens: 2,
      outputTokens: 10,
      cacheReadTokens: 30_000,
      cacheCreationTokens: 40_000,
      invokeContextDelta: null,
    },
    {
      kind: "skill",
      name: "shipwright:task-store",
      invocations: 1,
      turns: 3,
      inputTokens: 12,
      outputTokens: 100,
      cacheReadTokens: 219_200,
      cacheCreationTokens: 9_300,
      invokeContextDelta: 3 + 100,
    },
    {
      kind: "agent",
      name: "Explore",
      invocations: 1,
      turns: 1,
      inputTokens: 500,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      invokeContextDelta: null,
    },
  ],
};
