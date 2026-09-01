/**
 * lib/chat-notify.ts
 * Shared type for the chat service's outbound reply-notification webhook
 * (CFB-4.3) — imported by both the chat service (builds/sends the event) and,
 * potentially, the admin service (receives it at POST /admin/push/notify).
 *
 * Deliberately text-free: no message body/preview field. The payload is just
 * enough for the admin side to look up subscriptions and render a generic
 * "your agent replied" notification — the opt-in preview text (if any) is
 * fetched separately by admin from the message itself, not carried here.
 */

/** Event fired once per newly-persisted agent reply. */
export interface ReplyNotificationEvent {
  threadId: string;
  agentId: string;
  /** Thread title, or null when the thread has none. Never coerced to "". */
  title: string | null;
}

/**
 * Parses `v` as a ReplyNotificationEvent, returning null on any shape
 * mismatch (missing/wrong-typed fields). Used by callers that receive this
 * payload over the wire and need to validate it before trusting the shape.
 */
export function parseReplyNotificationEvent(
  v: unknown,
): ReplyNotificationEvent | null {
  if (typeof v !== "object" || v === null) return null;
  const obj = v as Record<string, unknown>;

  if (typeof obj.threadId !== "string") return null;
  if (typeof obj.agentId !== "string") return null;
  if (typeof obj.title !== "string" && obj.title !== null) return null;

  return {
    threadId: obj.threadId,
    agentId: obj.agentId,
    title: obj.title,
  };
}
