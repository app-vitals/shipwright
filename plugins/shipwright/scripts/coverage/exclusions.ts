/**
 * plugins/shipwright/scripts/coverage/exclusions.ts
 *
 * The per-repo coverage exclusion contract (`.shipwright/coverage.json`).
 * Parsing is strict: anything malformed throws a CoverageExclusionError that
 * names the offending entry, so a bad file is never silently ignored.
 */

export const EXCLUSION_FILE_PATH = ".shipwright/coverage.json";

export interface ExclusionEntry {
  path: string;
  reason: string;
}

export interface ExclusionConfig {
  maxExcludedPct: number;
  excludePrefixes: ExclusionEntry[];
  excludeSubstrings: ExclusionEntry[];
}

export class CoverageExclusionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoverageExclusionError";
  }
}

const fail = (msg: string): never => {
  throw new CoverageExclusionError(`${EXCLUSION_FILE_PATH}: ${msg}`);
};

function parseEntries(data: Record<string, unknown>, key: string) {
  const list = data[key];
  if (!Array.isArray(list)) return fail(`"${key}" must be an array`);
  return (list as unknown[]).map((raw, i): ExclusionEntry => {
    const where = `${key}[${i}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return fail(`${where} must be an object`);
    }
    const { path, reason } = raw as Record<string, unknown>;
    if (typeof path !== "string" || path === "") {
      return fail(`${where} needs a non-empty string "path"`);
    }
    if (typeof reason !== "string" || reason.trim() === "") {
      return fail(`${where} (path "${path}") is missing a non-empty "reason"`);
    }
    return { path, reason };
  });
}

/** Parses and validates the exclusion file; throws CoverageExclusionError. */
export function parseExclusionConfig(content: string): ExclusionConfig {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (e) {
    return fail(`invalid JSON (${e instanceof Error ? e.message : e})`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return fail("must be a JSON object");
  }
  const d = data as Record<string, unknown>;
  const max = d.maxExcludedPct;
  if (
    typeof max !== "number" ||
    !Number.isFinite(max) ||
    max < 0 ||
    max > 100
  ) {
    return fail(`"maxExcludedPct" must be a number between 0 and 100`);
  }
  return {
    maxExcludedPct: max,
    excludePrefixes: parseEntries(d, "excludePrefixes"),
    excludeSubstrings: parseEntries(d, "excludeSubstrings"),
  };
}

/** Same semantics as the repo CI gates: startsWith for prefixes, includes for substrings. */
export function isExcludedPath(config: ExclusionConfig, path: string): boolean {
  return (
    config.excludePrefixes.some((e) => path.startsWith(e.path)) ||
    config.excludeSubstrings.some((e) => path.includes(e.path))
  );
}

/** Entries that match none of the given report paths. */
export function findDeadEntries(
  config: ExclusionConfig,
  paths: string[],
): string[] {
  return [
    ...config.excludePrefixes
      .filter((e) => !paths.some((p) => p.startsWith(e.path)))
      .map((e) => `excludePrefixes: ${e.path}`),
    ...config.excludeSubstrings
      .filter((e) => !paths.some((p) => p.includes(e.path)))
      .map((e) => `excludeSubstrings: ${e.path}`),
  ];
}
