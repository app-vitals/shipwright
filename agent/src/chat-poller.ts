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

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaudeRunResult, ProgressCallback } from "./claude.ts";
import type { ChatServiceClient } from "./http-chat-service-client.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChatRunner = (
  message: string,
  sessionKey?: string,
  onProgress?: ProgressCallback,
) => Promise<ClaudeRunResult>;

/**
 * Minimum time between heartbeat() calls for a single claimed message.
 * ProgressCallback fires once per Claude turn, which can be much more
 * frequent than this — throttling keeps a chatty run from hammering the
 * chat service while still giving pollers proof of life well inside the
 * admin UI's 3s poll interval.
 */
const HEARTBEAT_MIN_INTERVAL_MS = 3_000;

export interface ChatPollerOptions {
  client: ChatServiceClient;
  runner: ChatRunner;
  /** Poll interval in ms. Default: 5000 */
  intervalMs?: number;
  /**
   * Agent workspace directory. When set, attachments on claimed messages are
   * pulled into `<workspaceDir>/uploads/` so Claude can Read them.
   */
  workspaceDir?: string;
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
  const { client, runner, intervalMs = 5_000, workspaceDir } = opts;

  let timer: ReturnType<typeof setInterval> | undefined;

  async function processThread(threadId: string): Promise<void> {
    const message = await client.claimMessage(threadId);
    if (!message) return; // no unclaimed messages — no-op

    const sessionKey = `chat:${threadId}`;

    // Pull an attachment into the workspace so Claude can Read it.
    let runnerMessage = message.body;
    if (message.attachmentFilename && workspaceDir) {
      try {
        const bytes = await client.getAttachment(threadId, message.id);
        if (bytes) {
          const safeFilename = message.attachmentFilename.replace(
            /[^\w.\-]+/g,
            "_",
          );
          const uploadsDir = join(workspaceDir, "uploads");
          await mkdir(uploadsDir, { recursive: true });
          const filePath = join(uploadsDir, `${message.id}-${safeFilename}`);
          await writeFile(filePath, bytes);
          runnerMessage = `${message.body}\n\n[Attached file: ${safeFilename} saved at ${filePath}]`;
        }
      } catch (err) {
        console.error(
          `[chat-poller] failed to pull attachment for thread ${threadId} message ${message.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Best-effort heartbeat while the run is in progress, throttled so a
    // chatty multi-turn run doesn't hammer the chat service. Failures are
    // swallowed — a missed heartbeat must never abort the reply itself.
    let lastHeartbeatSentAt = 0;
    const onProgress: ProgressCallback = () => {
      const now = Date.now();
      if (now - lastHeartbeatSentAt < HEARTBEAT_MIN_INTERVAL_MS) return;
      lastHeartbeatSentAt = now;
      client.heartbeat(threadId, message.id).catch((err) => {
        console.error(
          `[chat-poller] heartbeat failed for thread ${threadId} message ${message.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    };

    let runResult: Awaited<ReturnType<ChatRunner>>;
    try {
      runResult = await runner(runnerMessage, sessionKey, onProgress);
    } catch (err) {
      console.error(
        `[chat-poller] runner failed for thread ${threadId}:`,
        err instanceof Error ? err.message : String(err),
      );
      return;
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
