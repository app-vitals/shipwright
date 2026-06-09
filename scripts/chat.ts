/**
 * scripts/chat.ts
 * TUI chat REPL — terminal transport for the Shipwright agent's /chat endpoint.
 *
 * Usage:
 *   bun scripts/chat.ts
 *   AGENT_URL=http://localhost:3000 bun scripts/chat.ts
 *
 * Architecture:
 *   Pure functions (buildChatRequest, formatAgentResponse, fetchChatResponse,
 *   formatFetchError) are exported for unit testing — no I/O, no network.
 *   The I/O loop (runRepl) reads stdin line by line, drives the HTTP calls,
 *   and prints results. It is not unit-testable but exercises the same seam
 *   used by Slack DMs, so behaviour is consistent.
 *
 * The /chat endpoint must be enabled on the agent:
 *   SHIPWRIGHT_DEV_CHAT=true bun agent/src/entrypoint-main.ts
 *
 * No dependencies beyond Bun built-ins (fetch, readline, crypto.randomUUID).
 */

import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatRequestBody {
  message: string;
  session?: string;
}

export interface ChatResponseBody {
  result: string;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Pure functions (unit-testable, no I/O)
// ---------------------------------------------------------------------------

/**
 * Construct the POST body for /chat.
 * Omits `session` when it is absent or empty so the server treats the call
 * as a fresh conversation.
 */
export function buildChatRequest(
  message: string,
  session?: string,
): ChatRequestBody {
  if (session && session !== "") {
    return { message, session };
  }
  return { message };
}

/**
 * Format the agent's result string for terminal display.
 * Prepends "agent> " so the human can visually distinguish turns.
 */
export function formatAgentResponse(result: string): string {
  return `agent> ${result}`;
}

/**
 * Make the HTTP POST to /chat and return the parsed response.
 * Throws a plain Error (no stack trace surface) on non-2xx or network failure.
 */
export async function fetchChatResponse(
  url: string,
  body: ChatRequestBody,
): Promise<ChatResponseBody> {
  const response = await fetch(`${url}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `non-2xx response: ${response.status} ${response.statusText}`,
    );
  }

  return response.json() as Promise<ChatResponseBody>;
}

/**
 * Convert a fetch error into a friendly human-readable string.
 * Never exposes a stack trace — suitable for printing directly to the terminal.
 *
 * @param error  The caught value (any type — catch clauses are untyped).
 * @param url    The agent URL attempted, included in TypeError messages.
 */
export function formatFetchError(error: unknown, url: string): string {
  if (error instanceof TypeError) {
    // TypeError from fetch() = network-level failure (ECONNREFUSED, DNS, etc.)
    return `Cannot reach agent at ${url}. Is it running with SHIPWRIGHT_DEV_CHAT=true?`;
  }
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  // Fallback for non-Error thrown values (rare but possible)
  return `Error: ${String(error)}`;
}

// ---------------------------------------------------------------------------
// I/O loop (not unit-testable — contains stdin/stdout I/O)
// ---------------------------------------------------------------------------

/**
 * Run the REPL loop against the given agent URL.
 * Reads lines from stdin, posts each to /chat, prints the response.
 * The session string is generated once per run so successive turns resume
 * the same Claude conversation.
 * EOF (Ctrl-D) exits gracefully; fetch errors print a friendly message and
 * continue (the REPL does not crash).
 */
export async function runRepl(agentUrl: string): Promise<void> {
  // Single session key for the lifetime of this REPL process.
  const session = crypto.randomUUID();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  console.log(`Shipwright chat — connected to ${agentUrl}`);
  console.log("Type a message and press Enter. Ctrl-D to quit.\n");

  // Show the initial prompt before the first line arrives.
  process.stdout.write("you> ");

  for await (const line of rl) {
    const message = line.trim();
    if (message === "") {
      process.stdout.write("you> ");
      continue;
    }

    try {
      const body = buildChatRequest(message, session);
      const response = await fetchChatResponse(agentUrl, body);
      console.log(formatAgentResponse(response.result));
    } catch (err) {
      console.error(formatFetchError(err, agentUrl));
    }

    process.stdout.write("you> ");
  }

  // EOF — exit gracefully (no error, no stack trace)
  console.log("\nGoodbye.");
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const agentUrl = process.env.AGENT_URL ?? "http://localhost:3000";
  await runRepl(agentUrl);
}
