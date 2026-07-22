/**
 * Hand-authored synthetic `claude -p --output-format stream-json --verbose`
 * transcript: a session that is cut off mid-stream — two assistant turns are
 * emitted but NO terminal `result` line ever arrives (truncated output /
 * process killed).
 *
 * NOTE: hand-authored per the documented public schema, standing in for a real
 * capture to be validated later. The parser must surface whatever per-model
 * usage it accumulated from the `assistant` lines rather than discarding it.
 */

const SONNET = "claude-sonnet-4-6";
const OPUS = "claude-opus-4-8";
const SESSION_ID = "sess-truncated";

export const lines: string[] = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: SESSION_ID,
    model: SONNET,
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_a",
      role: "assistant",
      model: SONNET,
      content: [{ type: "text", text: "Working on it..." }],
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 0,
      },
    },
    session_id: SESSION_ID,
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_b",
      role: "assistant",
      model: OPUS,
      content: [{ type: "text", text: "Almost done" }],
      usage: {
        input_tokens: 150,
        output_tokens: 60,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 10,
      },
    },
    session_id: SESSION_ID,
  }),
  // stream is cut off here — no `result` line
];

/**
 * Everything the parser accumulated before the stream ended. costUSD is 0
 * (never learned the authoritative cost — no result event arrived).
 */
export const expectedAccumulated = {
  [SONNET]: {
    inputTokens: 100,
    outputTokens: 40,
    cacheReadInputTokens: 5,
    cacheCreationInputTokens: 0,
    costUSD: 0,
  },
  [OPUS]: {
    inputTokens: 150,
    outputTokens: 60,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 10,
    costUSD: 0,
  },
};
