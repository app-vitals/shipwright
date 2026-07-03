/**
 * admin/src/chat-markers.ts
 *
 * Marker parsing for chat message display in admin UI.
 * Strips response markers from displayed text and extracts URLs/paths for rendering.
 *
 * Supported markers:
 *   [silent]                        — stripped (Slack-only)
 *   [upload:/path/to/file]          — path extracted for artifact badge
 *   [speak:text]                    — stripped (Slack-only)
 *   [react:emoji1,emoji2]           — stripped (Slack-only)
 *   [plan:url]                      — URL extracted for link badge
 *
 * Note: This is a separate implementation from agent/src/markers.ts because
 * admin and agent are separate workspace packages with no cross-imports.
 */

export interface ParseChatMarkersResult {
  /** Message body with all markers removed. */
  cleaned: string;
  /** Extracted upload file paths (in order of occurrence). */
  uploads: string[];
  /** Extracted plan URLs (in order of occurrence). */
  planUrls: string[];
}

// Regex patterns — greedy non-nested matching.
const SILENT_REGEX = /\[silent\]\s*$/i;
const UPLOAD_REGEX = /\[upload:([^\]]+)\]/gi;
const SPEAK_REGEX = /\[speak:([\s\S]*?)\]/gi;
const REACT_REGEX = /\[react:([^\]]+)\]/gi;
const PLAN_REGEX = /\[plan:([^\]]+)\]/gi;

/**
 * Parse response markers from assistant chat message text.
 * Returns the cleaned text (all markers stripped) and arrays of extracted URLs/paths.
 *
 * @param text - the raw message body potentially containing markers
 * @returns cleaned text, upload paths, and plan URLs (all in order of occurrence)
 */
export function parseChatMarkers(text: string): ParseChatMarkersResult {
  const uploads: string[] = [];
  const planUrls: string[] = [];
  let cleaned = text;

  // [silent]
  if (SILENT_REGEX.test(cleaned)) {
    cleaned = cleaned.replace(SILENT_REGEX, "").trim();
  }

  // [upload:/path]
  cleaned = cleaned.replace(UPLOAD_REGEX, (_match, pathRaw: string) => {
    const path = pathRaw.trim();
    if (!path) {
      // Malformed: empty path. Leave in text.
      return _match;
    }
    uploads.push(path);
    return "";
  });
  UPLOAD_REGEX.lastIndex = 0;
  cleaned = cleaned.trim();

  // [speak:text] — Slack-only, strip silently
  cleaned = cleaned.replace(SPEAK_REGEX, (_match, textRaw: string) => {
    const text = textRaw.trim();
    if (!text) {
      // Malformed: empty text. Leave in text.
      return _match;
    }
    return "";
  });
  SPEAK_REGEX.lastIndex = 0;
  cleaned = cleaned.trim();

  // [react:emoji1,emoji2,...] — Slack-only, strip silently
  cleaned = cleaned.replace(REACT_REGEX, (_match, raw: string) => {
    const emojis = raw
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    if (emojis.length === 0) {
      // Malformed: empty emoji list. Leave in text.
      return _match;
    }
    return "";
  });
  REACT_REGEX.lastIndex = 0;
  cleaned = cleaned.trim();

  // [plan:url]
  cleaned = cleaned.replace(PLAN_REGEX, (_match, urlRaw: string) => {
    const url = urlRaw.trim();
    if (!url) {
      // Malformed: empty URL. Leave in text.
      return _match;
    }
    planUrls.push(url);
    return "";
  });
  PLAN_REGEX.lastIndex = 0;
  cleaned = cleaned.trim();

  return { cleaned, uploads, planUrls };
}
