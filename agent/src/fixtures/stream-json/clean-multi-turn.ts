/**
 * Hand-authored synthetic `claude -p --output-format stream-json --verbose`
 * transcript: a clean multi-turn, multi-model session that ends in a `result`
 * event.
 *
 * NOTE: These NDJSON lines are hand-authored per the documented public Claude
 * Code CLI stream-json/--verbose schema — they stand in for real captures that
 * will be swapped in and validated later. Each entry in `lines` is one JSON
 * object, exactly as the CLI emits one-per-line on stdout.
 *
 * Shape of the session:
 *  - one `system`/`init` line
 *  - assistant turn `msg_1` (sonnet) emitted TWICE with identical repeated usage
 *    (same message.id spanning two stream lines) — must be deduped to one turn
 *  - a `user` tool-result line (no usage)
 *  - assistant turn `msg_2` (sonnet)
 *  - assistant turn `msg_3` (opus) — a second, different model
 *  - one terminal `result`/success line carrying the authoritative
 *    modelUsage/total_cost_usd/usage (byte-identical in shape to the old
 *    single-blob `--output-format json` output)
 */

const SONNET = "claude-sonnet-4-6";
const OPUS = "claude-opus-4-8";
const SESSION_ID = "sess-clean-multi";

export const lines: string[] = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: SESSION_ID,
    model: SONNET,
    tools: ["Read", "Write", "Bash"],
  }),
  // msg_1 — first stream line for this turn
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_1",
      role: "assistant",
      model: SONNET,
      content: [{ type: "text", text: "Let me look into that." }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
    },
    session_id: SESSION_ID,
  }),
  // msg_1 — SAME message.id repeated (e.g. a tool-use block within the turn),
  // identical usage numbers — must NOT be double counted
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_1",
      role: "assistant",
      model: SONNET,
      content: [{ type: "tool_use", id: "tu_1", name: "Read", input: {} }],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
    },
    session_id: SESSION_ID,
  }),
  // tool-result feedback — no usage to accumulate
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
    },
    session_id: SESSION_ID,
  }),
  // msg_2 — same model, distinct turn
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_2",
      role: "assistant",
      model: SONNET,
      content: [{ type: "text", text: "Now switching models." }],
      usage: {
        input_tokens: 200,
        output_tokens: 80,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 0,
      },
    },
    session_id: SESSION_ID,
  }),
  // msg_3 — second, different model
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_3",
      role: "assistant",
      model: OPUS,
      content: [{ type: "text", text: "Final answer" }],
      usage: {
        input_tokens: 300,
        output_tokens: 150,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 30,
      },
    },
    session_id: SESSION_ID,
  }),
  // terminal result — authoritative totals (costUSD is only known here)
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Final answer",
    session_id: SESSION_ID,
    usage: {
      input_tokens: 600,
      output_tokens: 280,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 35,
    },
    total_cost_usd: 0.0579,
    modelUsage: {
      [SONNET]: {
        inputTokens: 300,
        outputTokens: 130,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 5,
        costUSD: 0.0123,
        webSearchRequests: 0,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
      [OPUS]: {
        inputTokens: 300,
        outputTokens: 150,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 30,
        costUSD: 0.0456,
        webSearchRequests: 0,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
    },
  }),
];

/**
 * The authoritative return the parser must reproduce byte-identically on a
 * clean exit — sourced from the terminal `result` event, NOT the running
 * accumulator.
 */
export const expected = {
  result: "Final answer",
  sessionId: SESSION_ID,
  totalCostUsd: 0.0579,
  modelUsage: {
    [SONNET]: {
      inputTokens: 300,
      outputTokens: 130,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 5,
      costUSD: 0.0123,
      webSearchRequests: 0,
      contextWindow: 200000,
      maxOutputTokens: 8192,
    },
    [OPUS]: {
      inputTokens: 300,
      outputTokens: 150,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 30,
      costUSD: 0.0456,
      webSearchRequests: 0,
      contextWindow: 200000,
      maxOutputTokens: 8192,
    },
  },
};

/**
 * The running per-model total the streaming parser accumulates from the
 * `assistant` lines alone (deduped by message.id). costUSD is 0 because cost is
 * not known until the terminal `result` event. This is what the final
 * `onProgress` callback should receive.
 */
export const expectedAccumulated = {
  [SONNET]: {
    inputTokens: 300, // 100 (msg_1, counted once) + 200 (msg_2)
    outputTokens: 130, // 50 + 80
    cacheReadInputTokens: 30, // 10 + 20
    cacheCreationInputTokens: 5, // 5 + 0
    costUSD: 0,
  },
  [OPUS]: {
    inputTokens: 300,
    outputTokens: 150,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 30,
    costUSD: 0,
  },
};

/** Distinct message ids in emission order — onProgress should fire once each. */
export const expectedProgressCount = 3;
