/**
 * Hand-authored synthetic `claude -p --output-format stream-json --verbose`
 * transcript exercising `agent/src/progress-milestones.ts`'s block → phase
 * mapping end-to-end through `_consumeStream`'s `handleLine` closure.
 *
 * Shape of the session:
 *  - one `system`/`init` line
 *  - assistant turn `msg_1`: a `thinking` block, then a `tool_use` Read block
 *    (no `usage` field on this line — a tool_use-only line must still be able
 *    to fire a phase update, exercised BEFORE the usage guard)
 *  - assistant turn `msg_2`: a second `tool_use` Read block (same phase as
 *    msg_1's Read — repeated identical phases must collapse to a single fire)
 *  - assistant turn `msg_3`: an `mcp__*`-prefixed tool name → generic `tool`
 *  - assistant turn `msg_4`: an unrecognized/unknown tool name → generic `tool`
 *  - assistant turn `msg_5`: a plain `text` block → `writing`
 *  - one terminal `result`/success line
 *
 * `tool_use` blocks intentionally carry `input` payloads containing
 * fake-secret-shaped values and absolute filesystem paths — the mapper must
 * never read `block.input`, so these values must never surface anywhere in
 * the resulting phase sequence.
 */

const SONNET = "claude-sonnet-4-6";
const SESSION_ID = "sess-progress-phases";

export const lines: string[] = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: SESSION_ID,
    model: SONNET,
    tools: ["Read", "Grep", "Bash"],
  }),
  // msg_1 — thinking block, then a tool_use Read block. No `usage` field:
  // exercises firing a phase BEFORE the existing usage guard.
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_1",
      role: "assistant",
      model: SONNET,
      content: [
        { type: "thinking", thinking: "Let me look at the file first." },
        {
          type: "tool_use",
          id: "tu_1",
          name: "Read",
          input: {
            file_path: "/home/alice/.ssh/id_rsa",
            api_key: "sk-fake-12345",
          },
        },
      ],
    },
    session_id: SESSION_ID,
  }),
  // tool-result feedback — out of scope for phase mapping
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
    },
    session_id: SESSION_ID,
  }),
  // msg_2 — a SECOND Read tool_use block: same phase ("reading") as msg_1's
  // Read block — must collapse to a single fire (no new phase event).
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_2",
      role: "assistant",
      model: SONNET,
      content: [
        {
          type: "tool_use",
          id: "tu_2",
          name: "Read",
          input: {
            command: "cat /home/alice/.ssh/id_rsa",
            api_key: "sk-fake-12345",
          },
        },
      ],
      usage: {
        input_tokens: 50,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    session_id: SESSION_ID,
  }),
  // msg_3 — an mcp__*-prefixed tool name → generic "tool" phase.
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_3",
      role: "assistant",
      model: SONNET,
      content: [
        {
          type: "tool_use",
          id: "tu_3",
          name: "mcp__linear__create_issue",
          input: { api_key: "sk-fake-12345" },
        },
      ],
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    session_id: SESSION_ID,
  }),
  // msg_4 — an unrecognized/unknown tool name → generic "tool" phase.
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_4",
      role: "assistant",
      model: SONNET,
      content: [
        {
          type: "tool_use",
          id: "tu_4",
          name: "SomeFutureTool",
          input: { secret: "sk-fake-12345" },
        },
      ],
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    session_id: SESSION_ID,
  }),
  // msg_5 — plain text block → "writing".
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_5",
      role: "assistant",
      model: SONNET,
      content: [{ type: "text", text: "Here's what I found." }],
      usage: {
        input_tokens: 30,
        output_tokens: 15,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    session_id: SESSION_ID,
  }),
  // terminal result
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Here's what I found.",
    session_id: SESSION_ID,
    usage: {
      input_tokens: 120,
      output_tokens: 35,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    total_cost_usd: 0.0042,
    modelUsage: {
      [SONNET]: {
        inputTokens: 120,
        outputTokens: 35,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.0042,
      },
    },
  }),
];

/**
 * The ordered sequence of DISTINCT phase fires `onProgress`/`perCallOnProgress`
 * should emit across this fixture (collapsed — a phase identical to the
 * immediately preceding fired phase does not fire again). `msg_1`'s thinking
 * block fires "thinking" first, then its Read tool_use fires "reading".
 * `msg_2`'s Read tool_use maps to the same "reading" phase as msg_1's —
 * collapsed, no second fire. `msg_3` (mcp__*) maps to the generic "tool"
 * phase — a new fire (differs from "reading"). `msg_4` (unknown tool) ALSO
 * maps to "tool" — identical to the immediately preceding fired phase, so it
 * collapses too (no second "tool" fire). `msg_5`'s text block fires "writing".
 */
export const expectedPhaseSequence = ["thinking", "reading", "tool", "writing"];

/**
 * Fake-secret-shaped substrings embedded in this fixture's `tool_use.input`
 * payloads — must never appear anywhere in the phase output.
 */
export const forbiddenSubstrings = ["/home/alice/.ssh/id_rsa", "sk-fake-12345"];
