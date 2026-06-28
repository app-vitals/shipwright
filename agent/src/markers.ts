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

export type Marker =
  | SilentMarker
  | UploadMarker
  | SpeakMarker
  | ReactMarker
  | PlanMarker;

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

  return { cleaned, markers };
}
