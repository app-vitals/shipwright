/**
 * Response marker parsing for agent replies.
 *
 * Claude can embed special markers in its response text to trigger side-effect
 * actions. Markers are stripped from the visible message before posting.
 *
 * Supported markers:
 *   [silent]                        — skip posting
 *   [upload:/path/to/file]          — upload a file
 *   [speak:text]                    — synthesize speech and upload audio file
 *   [react:emoji1,emoji2]           — add emoji reactions
 *   [plan:url]                      — post a "View plan" link to the channel/thread
 *   [skip-reason:text]              — tag a machine-readable reason for a silent
 *                                      dispatch; parsed independently of [silent]
 *                                      (does not require it to also be present),
 *                                      but only meaningful when it is — the
 *                                      loop orchestrator uses it as the
 *                                      skipRun() reason on a [silent] dispatch,
 *                                      falling back to "command:no-work" when
 *                                      absent (see agent/src/loop-orchestrator.ts)
 *
 * Malformed markers are logged and left in the cleaned text (not crashed on).
 */

interface SilentMarker {
  type: "silent";
}

interface UploadMarker {
  type: "upload";
  path: string;
}

interface SpeakMarker {
  type: "speak";
  text: string;
}

interface ReactMarker {
  type: "react";
  emojis: string[];
}

interface PlanMarker {
  type: "plan";
  url: string;
}

interface SkipReasonMarker {
  type: "skip-reason";
  reason: string;
}

export type Marker =
  | SilentMarker
  | UploadMarker
  | SpeakMarker
  | ReactMarker
  | PlanMarker
  | SkipReasonMarker;

interface ParseMarkersResult {
  cleaned: string;
  markers: Marker[];
}

// Regex patterns — greedy non-nested matching.
// [silent] must appear at the end of the response so meta-discussion of the
// marker (e.g. "Use [silent] to skip posting") doesn't accidentally silence it.
const SILENT_REGEX = /\[silent\]\s*$/i;
const UPLOAD_REGEX = /\[upload:([^\]]+)\]/gi;
const SPEAK_REGEX = /\[speak:([\s\S]*?)\]/gi;
const REACT_REGEX = /\[react:([^\]]+)\]/gi;
const PLAN_REGEX = /\[plan:([^\]]+)\]/gi;
const SKIP_REASON_REGEX = /\[skip-reason:([^\]]+)\]/gi;

/**
 * Parse all response markers from text.
 * Returns the cleaned text (markers stripped) and an ordered list of markers found.
 * Malformed markers are logged and left in the cleaned text.
 */
export function parseMarkers(text: string): ParseMarkersResult {
  const markers: Marker[] = [];
  let cleaned = text;

  // [silent]
  if (SILENT_REGEX.test(cleaned)) {
    markers.push({ type: "silent" });
    cleaned = cleaned.replace(SILENT_REGEX, "").trim();
  }

  // [upload:/path]
  cleaned = cleaned.replace(UPLOAD_REGEX, (_match, pathRaw: string) => {
    const path = pathRaw.trim();
    if (!path) {
      console.warn(
        "[markers] malformed [upload:] marker — empty path, leaving in text:",
        _match,
      );
      return _match;
    }
    markers.push({ type: "upload", path });
    return "";
  });
  UPLOAD_REGEX.lastIndex = 0;
  cleaned = cleaned.trim();

  // [speak:text]
  cleaned = cleaned.replace(SPEAK_REGEX, (_match, textRaw: string) => {
    const text = textRaw.trim();
    if (!text) {
      console.warn(
        "[markers] malformed [speak:] marker — empty text, leaving in text:",
        _match,
      );
      return _match;
    }
    markers.push({ type: "speak", text });
    return "";
  });
  SPEAK_REGEX.lastIndex = 0;
  cleaned = cleaned.trim();

  // [react:emoji1,emoji2,...]
  cleaned = cleaned.replace(REACT_REGEX, (_match, raw: string) => {
    const emojis = raw
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    if (emojis.length === 0) {
      console.warn(
        "[markers] malformed [react:] marker — empty emoji list, leaving in text:",
        _match,
      );
      return _match;
    }
    markers.push({ type: "react", emojis });
    return "";
  });
  REACT_REGEX.lastIndex = 0;
  cleaned = cleaned.trim();

  // [plan:url]
  cleaned = cleaned.replace(PLAN_REGEX, (_match, urlRaw: string) => {
    const url = urlRaw.trim();
    if (!url) {
      console.warn(
        "[markers] malformed [plan:] marker — empty url, leaving in text:",
        _match,
      );
      return _match;
    }
    markers.push({ type: "plan", url });
    return "";
  });
  PLAN_REGEX.lastIndex = 0;
  cleaned = cleaned.trim();

  // [skip-reason:text]
  cleaned = cleaned.replace(SKIP_REASON_REGEX, (_match, reasonRaw: string) => {
    const reason = reasonRaw.trim();
    if (!reason) {
      console.warn(
        "[markers] malformed [skip-reason:] marker — empty reason, leaving in text:",
        _match,
      );
      return _match;
    }
    markers.push({ type: "skip-reason", reason });
    return "";
  });
  SKIP_REASON_REGEX.lastIndex = 0;
  cleaned = cleaned.trim();

  return { cleaned, markers };
}
