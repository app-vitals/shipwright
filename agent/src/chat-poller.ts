/**
 * agent/src/chat-poller.ts
 *
 * Chat poll loop — polls the chat service for pending user messages, runs them
 * through Claude, and posts replies back.
 *
 * The poll loop:
 *  1. Lists threads for the agent (via ChatServiceClient.listThreads)
 *  2. For each thread, attempts to claim the next unclaimed user message
 *  3. For a claimed message: runs it through the Claude runner with
 *     `chat:<threadId>` as the session key, then posts the reply
 *
 * Error isolation: failures on individual threads are caught and logged; other
 * threads continue processing.
 */

import type { ChatServiceClient } from "./http-chat-service-client.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChatRunner = (
  message: string,
  sessionKey?: string,
) => Promise<{
  result: string;
  sessionId?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  totalCostUsd?: number;
}>

export interface SessionStore {
  get: (key: string) => string | undefined;
  set: (key: string, id: string) => void;
}

export interface ChatPollerOptions {
  client: ChatServiceClient;
  runner: ChatRunner;
  sessions: SessionStore;
  /** Poll interval in ms. Default: 5000 */
  intervalMs?: number;
}

export interface ChatPoller {
  /** Start the poll interval. */
  start(): void;
  /** Stop the poll interval. */
  stop(): void;
  /** Run a single poll iteration. Exposed for testing. */
  pollOnce(): Promise<void>;
}

// ─── createChatPoller ─────────────────────────────────────────────────────────

export function createChatPoller(opts: ChatPollerOptions): ChatPoller {
  const { client, runner, sessions, intervalMs = 5_000 } = opts;

  let timer: ReturnType<typeof setInterval> | undefined;

  async function processThread(threadId: string): Promise<void> {
    const message = await client.claimMessage(threadId);
    if (!message) return; // no unclaimed messages — no-op

    const sessionKey = `chat:${threadId}`;

    let runResult: Awaited<ReturnType<ChatRunner>>;
    try {
      runResult = await runner(message.body, sessionKey);
    } catch (err) {
      console.error(
        `[chat-poller] runner failed for thread ${threadId}:`,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    // Persist updated session ID so the next message in this thread resumes
    if (runResult.sessionId) {
      sessions.set(sessionKey, runResult.sessionId);
    }

    try {
      await client.replyToMessage(threadId, message.id, {
        body: runResult.result,
        tokens: runResult.usage,
        costUsd: runResult.totalCostUsd,
      });
    } catch (err) {
      console.error(
        `[chat-poller] replyToMessage failed for thread ${threadId} message ${message.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async function pollOnce(): Promise<void> {
    let listResult: Awaited<ReturnType<typeof client.listThreads>>;
    try {
      listResult = await client.listThreads({});
    } catch (err) {
      console.error(
        "[chat-poller] listThreads failed:",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    if (listResult.threads.length === 0) return;

    // Process each thread independently — errors on one must not block others
    await Promise.all(
      listResult.threads.map((thread) =>
        processThread(thread.id).catch((err) => {
          console.error(
            `[chat-poller] error processing thread ${thread.id}:`,
            err instanceof Error ? err.message : String(err),
          );
        }),
      ),
    );
  }

  return {
    start() {
      if (timer) return; // already running
      timer = setInterval(() => void pollOnce(), intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    pollOnce,
  };
}
