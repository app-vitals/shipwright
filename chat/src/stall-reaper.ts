/**
 * chat/src/stall-reaper.ts
 *
 * StallReaper — background job that terminalizes stalled user messages so a
 * dead agent cannot wedge a message forever.
 *
 * An agent-side sweep cannot help when the agent itself is the thing that
 * died, so this reaper lives in the chat service, which already owns the
 * Message lifecycle.
 *
 * A claimed, unreplied user message is considered stalled when:
 *   1. heartbeatAt IS NOT NULL and heartbeatAt < cutoff (agent stopped beating)
 *   2. heartbeatAt IS NULL and claimedAt < cutoff (agent died before its first beat)
 *
 * The cutoff is: clock.now() - stalledAfterMs. stalledAfterMs defaults to
 * CHAT_STALLED_AFTER_MS (300_000ms / 5min) — deliberately 2.5x the admin UI's
 * 120s STALL_WARN_AFTER_MS warning threshold (see admin/src/admin-ui-pages.ts),
 * because a warning is free but reaping is destructive.
 *
 * Reaping calls the EXISTING MessageService.reply(id, { errorKind: "stalled" })
 * — reuse, not new code. reply() already:
 *   - runs as a single transaction (repliedAt stamp + assistant message land
 *     together or not at all)
 *   - returns null when the message is already replied, which makes this
 *     sweep idempotent and race-safe against an agent that comes back to
 *     life mid-sweep, and safe to run concurrently across replicas.
 *
 * This reaper MARKS STALLED — it never unclaims for retry. Silently
 * re-running a prompt whose side effects may have already landed (files
 * edited, a PR opened, a deploy triggered) is unacceptable.
 *
 * Deliberately NO new index on heartbeatAt/claimedAt — indexing a column that
 * both a Message.claim() (heartbeatAt implicitly) *sets frequently* would
 * break HOT (heap-only tuple) updates on every heartbeat write. The query
 * below reuses the existing [claimed, threadId] index for the claimed=true
 * filter and falls through to a sequential scan for the OR clause, which is
 * fine at this table's scale and sweep cadence (60s).
 *
 * Usage: register via setInterval(() => reaper.reap(), 60_000) in main.ts —
 * NEVER inside the app.ts factory, which must stay side-effect-free.
 */

import { type Clock, SystemClock } from "./clock.ts";
import type { PrismaClient } from "./index.ts";
import type { Message, MessageServiceLike } from "./message-service.ts";

/** Default stall threshold: 300s = 2.5x the UI's 120s STALL_WARN_AFTER_MS. */
export const DEFAULT_STALLED_AFTER_MS = 300_000;

const STALLED_REPLY_BODY =
  "This message stalled and did not receive a response.";

export class StallReaper {
  /** The resolved stall threshold (ms), read once at construction. */
  readonly stalledAfterMs: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly messageService: MessageServiceLike,
    private readonly clock: Clock = SystemClock(),
    stalledAfterMs?: number,
  ) {
    this.stalledAfterMs =
      stalledAfterMs ??
      Number(process.env.CHAT_STALLED_AFTER_MS ?? DEFAULT_STALLED_AFTER_MS);
  }

  /**
   * Find claimed, unreplied user messages that have gone silent past the
   * stall threshold and terminalize each via MessageService.reply(). Returns
   * the count of messages successfully terminalized by this sweep.
   *
   * One bad row never aborts the sweep — each reply() call is individually
   * try/caught so a single throw (or a race where the message vanished) still
   * lets the rest of the candidates get processed.
   */
  async reap(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - this.stalledAfterMs);

    const candidates: Message[] = await this.prisma.message.findMany({
      where: {
        role: "user",
        claimed: true,
        repliedAt: null,
        OR: [
          { heartbeatAt: { lt: cutoff } },
          { heartbeatAt: null, claimedAt: { lt: cutoff } },
        ],
      },
    });

    let reaped = 0;
    for (const candidate of candidates) {
      try {
        // reply() returns null when the message is already replied (e.g. an
        // agent that resumed and beat the sweep to it) — that's not a bad
        // row, it's the idempotency contract working as designed.
        const result = await this.messageService.reply(candidate.id, {
          body: STALLED_REPLY_BODY,
          errorKind: "stalled",
        });
        if (result !== null) reaped++;
      } catch (err) {
        console.error(
          `[stall-reaper] failed to reap message ${candidate.id}:`,
          err,
        );
      }
    }

    if (reaped > 0) {
      console.log(`[stall-reaper] reaped ${reaped} stalled message(s)`);
    }

    return reaped;
  }
}
