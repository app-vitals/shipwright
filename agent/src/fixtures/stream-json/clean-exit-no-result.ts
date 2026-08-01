/**
 * Hand-authored synthetic `claude -p --output-format stream-json --verbose`
 * transcript: the process exits CLEANLY (exit code 0) but the stream ends
 * without ever emitting a terminal `result` line — e.g. the CLI closed stdout
 * right after its last turn without writing the final summary line.
 *
 * Distinct from truncated-no-result.ts (which pairs with a non-zero exit
 * code): this fixture exercises the `streamIncomplete: true` clean-exit return
 * path in `_spawn`, which must still surface the `session_id` captured off
 * the leading `system`/`init` line even though no terminal `result` event
 * ever carried one.
 */

const SONNET = "claude-sonnet-4-6";
const SESSION_ID = "sess-clean-exit-no-result";

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
      id: "msg_1",
      role: "assistant",
      model: SONNET,
      content: [{ type: "text", text: "Working on it..." }],
      usage: {
        input_tokens: 90,
        output_tokens: 30,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    session_id: SESSION_ID,
  }),
  // stream closes cleanly here — no `result` line
];

export const expectedAccumulated = {
  [SONNET]: {
    inputTokens: 90,
    outputTokens: 30,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUSD: 0,
  },
};

export const expectedSessionId = SESSION_ID;
