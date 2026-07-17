/**
 * agent/src/piper-voice.ts
 *
 * Discovery-based validation for the PIPER_VOICE config value, plus a
 * resolver that turns a validated voice name into the baked `.onnx` /
 * `.onnx.json` pair path.
 *
 * Piper voices are baked into the image at VOICES_DIR — a hardcoded
 * constant, not env-configurable. Voice selection must fail loudly at
 * startup (log the requested value and everything actually discovered)
 * rather than silently at speak time, so this module owns that check.
 * Actual Piper synthesis is a future task (PPR-1.2); this module only
 * validates + resolves paths.
 *
 * The directory scan mirrors the non-throwing, injectable-readdir pattern
 * used by discoverBakedMarketplaces (agent/src/setup.ts) and scanReposDir
 * (agent/src/check-helpers.ts): readdirSync wrapped in try/catch, empty
 * array on failure, and the readdir function itself is swappable so unit
 * tests never touch the real filesystem.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Default voice used when PIPER_VOICE is unset. Must be present in every baked image. */
export const DEFAULT_PIPER_VOICE = "en_US-hfc_female-medium";

/**
 * Baked voices directory. Hardcoded, not env-configurable — voice
 * availability is an IMAGE property (mirrors BAKED_MARKETPLACES_ROOT in
 * setup.ts).
 */
export const VOICES_DIR = "/app/agent/voices/";

export type ReaddirFn = (dir: string) => string[];

const defaultReaddirFn: ReaddirFn = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * Scans `dir` for Piper voice files and returns the distinct base voice
 * names found (each voice ships as a `<name>.onnx` + `<name>.onnx.json`
 * pair — this collapses both into one name). Non-throwing.
 */
function discoverVoices(dir: string, readdirFn: ReaddirFn): string[] {
  let entries: string[];
  try {
    entries = readdirFn(dir);
  } catch {
    return [];
  }

  const names = new Set<string>();
  for (const entry of entries) {
    if (entry.endsWith(".onnx.json")) {
      names.add(entry.slice(0, -".onnx.json".length));
    } else if (entry.endsWith(".onnx")) {
      names.add(entry.slice(0, -".onnx".length));
    }
  }
  return [...names];
}

/**
 * Validates the requested PIPER_VOICE against the discovered baked voices
 * directory and returns the voice name to use.
 *
 * - PIPER_VOICE unset -> returns DEFAULT_PIPER_VOICE.
 * - PIPER_VOICE set and found in the directory listing -> returns it as-is.
 * - PIPER_VOICE set but NOT found -> logs loudly (naming both the requested
 *   voice and every voice actually discovered) and falls back to
 *   DEFAULT_PIPER_VOICE. Never throws — a startup misconfiguration here
 *   must not crash the agent.
 */
export function validatePiperVoice(
  requestedVoice: string | undefined,
  readdirFn: ReaddirFn = defaultReaddirFn,
): string {
  const discovered = discoverVoices(VOICES_DIR, readdirFn);

  if (requestedVoice === undefined) {
    return DEFAULT_PIPER_VOICE;
  }

  if (discovered.includes(requestedVoice)) {
    return requestedVoice;
  }

  console.warn(
    `[piper-voice] PIPER_VOICE "${requestedVoice}" was not found in ${VOICES_DIR}. ` +
      `Discovered voices: ${discovered.length > 0 ? discovered.join(", ") : "(none)"}. ` +
      `Falling back to default voice "${DEFAULT_PIPER_VOICE}".`,
  );

  return DEFAULT_PIPER_VOICE;
}

/**
 * Resolves a validated voice name into its baked `.onnx` / `.onnx.json`
 * pair path. Centralizes directory logic so a future synthesizePiper
 * (PPR-1.2) doesn't duplicate it.
 */
export function resolvePiperVoicePaths(voiceName: string): {
  onnxPath: string;
  onnxJsonPath: string;
} {
  return {
    onnxPath: join(VOICES_DIR, `${voiceName}.onnx`),
    onnxJsonPath: join(VOICES_DIR, `${voiceName}.onnx.json`),
  };
}
