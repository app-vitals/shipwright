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
 * Heartbeat cadence while a reply is in flight.
 *
 * Interval-driven, NOT progress-driven. A single long-running tool call (a
 * multi-minute `Bash`, say) emits one stream event and then nothing at all
 * until it returns, so a heartbeat tied to Claude turns goes silent during
 * exactly the long wait it exists to cover. Liveness is a property of the
 * agent process, not of the model's output cadence — so it gets its own
 * timer. 3s keeps proof of life well inside the admin UI's poll interval.
 */
const HEARTBEAT_INTERVAL_MS = 3_000;

export interface ChatPollerOptions {
  client: ChatServiceClient;
  runner: ChatRunner;
  /** Poll interval in ms. Default: 5000 */
  intervalMs?: number;
  /** Heartbeat cadence in ms while a reply is in flight. Default: 3000 */
  heartbeatIntervalMs?: number;
  /**
   * Agent workspace directory. When set, attachments on claimed messages are
   * pulled into `<workspaceDir>/uploads/` so Claude can Read them.
   */
  workspaceDir?: string;
  /** Injected for tests so timer behavior is deterministic. */
  setIntervalFn?: typeof setInterval;
  /** Injected for tests so timer behavior is deterministic. */
  clearIntervalFn?: typeof clearInterval;
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
  const {
    client,
    runner,
    intervalMs = 5_000,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    workspaceDir,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = opts;

  let timer: ReturnType<typeof setInterval> | undefined;
  /** Guards against a slow poll overlapping the next interval tick. */
  let pollInFlight = false;

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

    // Best-effort liveness heartbeat, running for the whole duration of the
    // reply. Failures are swallowed — a missed heartbeat must never abort the
    // reply itself.
    const sendHeartbeat = () => {
      client.heartbeat(threadId, message.id).catch((err) => {
        console.error(
          `[chat-poller] heartbeat failed for thread ${threadId} message ${message.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    };

    let runResult: Awaited<ReturnType<ChatRunner>>;
    const heartbeatTimer = setIntervalFn(sendHeartbeat, heartbeatIntervalMs);
    try {
      runResult = await runner(runnerMessage, sessionKey);
    } catch (err) {
      console.error(
        `[chat-poller] runner failed for thread ${threadId}:`,
        err instanceof Error ? err.message : String(err),
      );
      return;
    } finally {
      clearIntervalFn(heartbeatTimer);
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
      // Skip a tick when the previous iteration is still running. A poll that
      // outlives its interval (a long claim + reply cycle always does) would
      // otherwise stack concurrent iterations for as long as it runs.
      timer = setIntervalFn(() => {
        if (pollInFlight) return;
        pollInFlight = true;
        void pollOnce().finally(() => {
          pollInFlight = false;
        });
      }, intervalMs);
    },
    stop() {
      if (timer) {
        clearIntervalFn(timer);
        timer = undefined;
      }
    },
    pollOnce,
  };
}
