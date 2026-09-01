/**
 * admin/src/push-content.ts
 * The notification-content POLICY, as pure functions.
 *
 * A notification renders on a LOCKED phone, possibly in public. So the visible
 * fields are deliberately austere:
 *   - generic : title "Your agent replied", no body.       (default, safest)
 *   - title   : + the thread's title in the body.
 *   - preview : + up to 120 chars of the reply preview.
 *
 * NEVER included at ANY level, in ANY visible field: agent name (agent names
 * are frequently client-shaped), ids, repo names, file paths, costs. The thread
 * title and preview are USER-authored free text, so they could themselves
 * contain such tokens — sanitizePublic() scrubs id/repo/path shapes before they
 * reach a lock screen. The deep-link `url` is the ONLY field allowed to carry a
 * threadId (the phone consumes it, it isn't rendered on the lock screen).
 */

export type PushDetailLevel = "generic" | "title" | "preview";

const LEVELS: PushDetailLevel[] = ["generic", "title", "preview"];
const LEVEL_RANK: Record<PushDetailLevel, number> = {
  generic: 0,
  title: 1,
  preview: 2,
};

/** Operator ceiling default per the brief. */
export const DEFAULT_MAX_DETAIL: PushDetailLevel = "title";
/** Safest per-subscription default. */
export const DEFAULT_OPT_IN: PushDetailLevel = "generic";

const GENERIC_TITLE = "Your agent replied";
const PREVIEW_MAX = 120;

function isLevel(v: unknown): v is PushDetailLevel {
  return typeof v === "string" && (LEVELS as string[]).includes(v);
}

/**
 * Effective detail level = min(operator ceiling, user opt-in). An unknown/unset
 * ceiling falls back to the operator default (title); an unknown/unset opt-in
 * falls back to the safest level (generic).
 */
export function resolveDetailLevel(
  ceiling: PushDetailLevel | string | undefined,
  optIn: PushDetailLevel | string | undefined,
): PushDetailLevel {
  const c = isLevel(ceiling) ? ceiling : DEFAULT_MAX_DETAIL;
  const o = isLevel(optIn) ? optIn : DEFAULT_OPT_IN;
  return LEVEL_RANK[c] <= LEVEL_RANK[o] ? c : o;
}

export interface NotificationThread {
  threadId: string;
  agentId: string;
  title?: string | null;
  /** The reply text (or a slice of it) used to build a preview. */
  preview?: string | null;
}

export interface NotificationPayload {
  title: string;
  body: string;
  /** Deep link to the thread — consumed by the SW, not shown on the lock screen. */
  url: string;
}

// Token shapes that must never surface on a lock screen. Applied to any
// user-authored free text (thread title / preview) before it is rendered.
const ID_SHAPE = /\b[a-z]{2,}[_-][A-Za-z0-9_-]{4,}\b/g; // agt_..., thr_..., WLS-2.2-ish
const CUID_SHAPE = /\bc[a-z0-9]{24}\b/g; // prisma cuid
const REPO_SHAPE = /\b[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*\b/g; // owner/repo, src/foo/bar.ts
const COST_SHAPE = /\$\s?\d[\d,]*(?:\.\d+)?/g; // $4.20

/**
 * Scrubs id/repo/path/cost shapes out of user-authored free text so nothing
 * client-shaped reaches a lock screen. Conservative by design: a false-positive
 * redaction (an innocuous slash-word) is strictly safer than a leak.
 */
export function sanitizePublic(text: string): string {
  return text
    .replace(CUID_SHAPE, "…")
    .replace(REPO_SHAPE, "…")
    .replace(ID_SHAPE, "…")
    .replace(COST_SHAPE, "…")
    .replace(/\s+/g, " ")
    .trim();
}

/** Builds the notification payload for a resolved detail level. */
export function buildNotificationPayload(
  level: PushDetailLevel,
  thread: NotificationThread,
): NotificationPayload {
  const url = `/admin/chat/${encodeURIComponent(
    thread.agentId,
  )}/threads/${encodeURIComponent(thread.threadId)}`;

  if (level === "generic") {
    return { title: GENERIC_TITLE, body: "", url };
  }

  if (level === "title") {
    const safeTitle = sanitizePublic(thread.title ?? "");
    return { title: GENERIC_TITLE, body: safeTitle, url };
  }

  // preview
  const raw = sanitizePublic(thread.preview ?? thread.title ?? "");
  const body = raw.length > PREVIEW_MAX ? raw.slice(0, PREVIEW_MAX) : raw;
  return { title: GENERIC_TITLE, body, url };
}
