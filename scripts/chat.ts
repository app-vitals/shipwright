#!/usr/bin/env bun
/**
 * scripts/chat.ts
 * Terminal REPL chat client for the Shipwright agent's POST /chat endpoint.
 *
 * Replaces Slack as the human transport: read a line from stdin, POST
 * { message, session } to $AGENT_URL/chat (default http://localhost:3000),
 * print the result, and reuse the SAME session key across turns so the agent
 * resumes the same conversation.
 *
 * Usage:
 *   bun scripts/chat.ts
 *   AGENT_URL=http://localhost:4000 bun scripts/chat.ts
 *
 * Architecture / testability:
 *   The pure, I/O-free helpers (buildChatRequest, formatChatResponse,
 *   formatUnreachableError, newSession) are exported and unit-tested without a
 *   socket. The async runRepl(...) loop owns all I/O and takes an injectable
 *   fetchFn seam so it never needs global overrides to be testable.
 *
 * No dependencies beyond Bun built-ins.
 */

const DEFAULT_BASE_URL = "http://localhost:3000";

/** A successful /chat response shape (sessionId is informational only). */
export interface ChatSuccess {
  result?: string;
  sessionId?: string;
}

/**
 * Build the URL + fetch init for a single /chat turn.
 *
 * @param message  the user's message
 * @param session  the STABLE per-REPL session key (reused every turn)
 * @param baseUrl  agent base URL; defaults to http://localhost:3000
 */
export function buildChatRequest(
  message: string,
  session: string,
  baseUrl: string = process.env.AGENT_URL || DEFAULT_BASE_URL,
): { url: string; init: RequestInit } {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return {
    url: `${trimmed}/chat`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, session }),
    },
  };
}

/** Format a successful response into the text printed after "agent> ". */
export function formatChatResponse(body: ChatSuccess): string {
  const text = (body.result ?? "").trimEnd();
  return text === "" ? "(no response)" : text;
}

/** Turn a thrown fetch error into a friendly, one-line, stack-free message. */
export function formatUnreachableError(url: string, _error: unknown): string {
  return `⚠ Could not reach the agent at ${url}. Is it running? (set $AGENT_URL to override)`;
}

/** Generate a stable opaque session id once at REPL startup. */
export function newSession(): string {
  return crypto.randomUUID();
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const EXIT_WORDS = new Set(["exit", "quit"]);

/**
 * The interactive REPL loop. Owns all I/O. fetchFn is injectable so the loop
 * is testable without overriding globals.
 */
export async function runRepl(
  fetchFn: FetchFn = globalThis.fetch,
  baseUrl: string = process.env.AGENT_URL || DEFAULT_BASE_URL,
): Promise<void> {
  const session = newSession();
  process.stdout.write(
    `Shipwright chat — talking to ${baseUrl}\nType a message and press Enter. "exit"/"quit" or Ctrl-D to leave.\n\n`,
  );

  process.stdout.write("you> ");
  for await (const raw of console) {
    const message = raw.trim();

    if (message === "" || EXIT_WORDS.has(message.toLowerCase())) {
      if (EXIT_WORDS.has(message.toLowerCase())) break;
      process.stdout.write("you> ");
      continue;
    }

    const { url, init } = buildChatRequest(message, session, baseUrl);
    try {
      const res = await fetchFn(url, init);
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        const detail = errBody.error ?? `HTTP ${res.status}`;
        process.stdout.write(`agent> ⚠ request failed: ${detail}\n\n`);
      } else {
        const body = (await res.json()) as ChatSuccess;
        process.stdout.write(`agent> ${formatChatResponse(body)}\n\n`);
      }
    } catch (error) {
      process.stdout.write(`agent> ${formatUnreachableError(url, error)}\n\n`);
    }

    process.stdout.write("you> ");
  }

  process.stdout.write("\nbye.\n");
}

if (import.meta.main) {
  await runRepl();
}
