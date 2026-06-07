#!/usr/bin/env bun
// Classify file paths and unified diffs into test layers (unit/integration/smoke/e2e).
// CLI: bun run shipwright/classify_test_layer.ts <path>... or pipe paths via stdin.

// ─── Types ────────────────────────────────────────────────────────────────────

export type LayerName = "unit" | "integration" | "smoke" | "e2e";

export type LayerDef = {
  name: LayerName;
  patterns: string[];
};

export type LoadDefsResult = {
  defs: LayerDef[];
  source: "test-system.md" | "defaults";
};

export type ParsedDecision = {
  layers: LayerName[];
  added: string[];
  retired: string[];
};

export type ConformanceDeviation = {
  module: string; // the directory pattern that prescribed the layer (e.g. "time/**")
  prescribed: LayerName;
  observed: LayerName;
};

export type ConformanceReport = {
  checked: boolean; // false when test-system.md is absent (defs come from defaults)
  deviations: ConformanceDeviation[];
};

export type FileReader = (path: string) => Promise<string>;

// ─── Plan-session Step 2 defaults ─────────────────────────────────────────────
// Layer definitions per docs/test-readiness/test-system.md § "Framework matrix per layer"
// and plan-session Step 2 canonical defaults.
//
// Precedence: smoke → e2e → unit → integration (most-specific suffix patterns first,
// so lib/api-auth.smoke.test.ts and api/health.smoke.test.ts route to "smoke", not
// "unit" via the lib/** / directory glob). The **/* variants are required because
// bare *.smoke.test.ts only matches root-level files (no / in path).

export const PLAN_SESSION_DEFAULTS: LayerDef[] = [
  {
    name: "smoke",
    patterns: ["**/*.smoke.test.ts", "*.smoke.test.ts"],
  },
  {
    name: "e2e",
    patterns: ["**/*.e2e.test.ts", "*.e2e.test.ts", "e2e/**"],
  },
  {
    name: "unit",
    patterns: ["**/*.unit.test.ts", "*.unit.test.ts", "scripts/**", "lib/**"],
  },
  {
    name: "integration",
    patterns: [
      "**/*.integration.test.ts",
      "*.integration.test.ts",
      "time/**",
      "accounts/**",
      "billing/**",
      "cal/**",
    ],
  },
];

// Path to the test-system.md file (relative to repo root, used during CLI run)
const TEST_SYSTEM_MD_PATH = "docs/test-readiness/test-system.md";

// ─── matchesGlob ──────────────────────────────────────────────────────────────
// Minimal glob matcher supporting:
//   * — any characters (excluding /)
//   ** — any characters (including /)
//   Prefix match: "time/**" matches "time/anything"

function matchesGlob(path: string, pattern: string): boolean {
  // Escape regex special chars except * and /
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");

  // Convert ** and * to regex equivalents.
  // Strategy: split on **, map each segment (replacing * with [^/]*), rejoin with .*
  const parts = escaped.split(/\\\*\\\*|\*\*/);
  const regexStr = parts.map((part) => part.replace(/\*/g, "[^/]*")).join(".*");

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(path);
}

export function classifyPath(
  path: string,
  defs: LayerDef[],
): LayerName | "unknown" {
  for (const def of defs) {
    for (const pattern of def.patterns) {
      if (matchesGlob(path, pattern)) {
        return def.name;
      }
    }
  }
  return "unknown";
}

export async function loadDefs(
  fileReader: FileReader,
): Promise<LoadDefsResult> {
  try {
    const content = await fileReader(TEST_SYSTEM_MD_PATH);
    const defs = parseTestSystemMd(content);
    if (defs.length > 0) {
      return { defs, source: "test-system.md" };
    }
    // File present but no parseable layer table — fall back
    return { defs: PLAN_SESSION_DEFAULTS, source: "defaults" };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[classify_test_layer] loadDefs error:", e);
    }
    return { defs: PLAN_SESSION_DEFAULTS, source: "defaults" };
  }
}

// ─── parseTestSystemMd ────────────────────────────────────────────────────────
// Parse the layer definitions table from test-system.md.
// Looks for markdown table rows with bold layer names like **unit**.

function parseTestSystemMd(content: string): LayerDef[] {
  const defs: LayerDef[] = [];
  const VALID_LAYERS: LayerName[] = ["unit", "integration", "smoke", "e2e"];

  // Match table rows like: | **unit** | *.unit.test.ts, scripts/**, lib/** |
  const rowRegex = /\|\s*\*\*(\w+)\*\*\s*\|\s*([^|]+)\|/g;
  const matches = [...content.matchAll(rowRegex)];

  for (const match of matches) {
    const layerName = match[1].toLowerCase() as LayerName;
    if (!VALID_LAYERS.includes(layerName)) continue;

    const patternsRaw = match[2].trim();
    const patterns = patternsRaw
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    defs.push({ name: layerName, patterns });
  }

  return defs;
}

export function parseDiff(
  diffText: string,
  defs: LayerDef[],
): Record<string, number> {
  const counts: Record<string, number> = {};

  // Initialize counts for all layers
  for (const def of defs) {
    counts[def.name] = 0;
  }

  const lines = diffText.split("\n");
  // Track the path seen on the preceding "--- a/" line so we can distinguish
  // a true addition (+++ b/<new-file>) from a modification (--- a/<file> then
  // +++ b/<same-file>). Modifications must not be counted as additions.
  let lastMinusPath: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("--- a/")) {
      // Record path for the upcoming +++ line; also check for deletions.
      const filePath = line.slice(6).trim();
      lastMinusPath = filePath;
      if (isClassifiableTestFile(filePath, defs)) {
        const nextLine = lines[i + 1];
        if (nextLine?.startsWith("+++ /dev/null")) {
          const layer = classifyPath(filePath, defs);
          if (layer !== "unknown") {
            counts[layer] = (counts[layer] ?? 0) - 1;
          }
        }
      }
    } else if (line.startsWith("+++ b/")) {
      const filePath = line.slice(6).trim();
      // Only count as an addition if the preceding --- a/ was a different path
      // (or there was none). Same path = modification, not a new file.
      if (
        filePath !== lastMinusPath &&
        isClassifiableTestFile(filePath, defs)
      ) {
        const layer = classifyPath(filePath, defs);
        if (layer !== "unknown") {
          counts[layer] = (counts[layer] ?? 0) + 1;
        }
      }
      lastMinusPath = null;
    } else if (!line.startsWith("---")) {
      // Any non-diff-header line resets the lastMinusPath guard so stray
      // --- a/ lines don't accidentally suppress unrelated +++ b/ lines.
      lastMinusPath = null;
    }
  }

  return counts;
}

// A file is a "test file" if it matches any glob pattern starting with "*" in the
// active defs. Using suffix patterns only (not directory patterns like "time/**")
// prevents non-test source files in service directories from being miscounted.
// This approach is language-agnostic: Python defs with "**/test_*.py", Java defs
// with "**/*Test.java", etc. all work without changes to this function.
function isClassifiableTestFile(path: string, defs: LayerDef[]): boolean {
  return defs.some((def) =>
    def.patterns
      .filter((p) => p.startsWith("*"))
      .some((p) => matchesGlob(path, p)),
  );
}

// Returns per-file additions from a git diff (added files only, not modifications/deletions)
export function parseDiffAdditions(
  diffText: string,
  defs: LayerDef[],
): Array<{ path: string; layer: LayerName }> {
  const additions: Array<{ path: string; layer: LayerName }> = [];
  const lines = diffText.split("\n");
  let lastMinusPath: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("--- a/")) {
      const filePath = line.slice(6).trim();
      lastMinusPath = filePath;
    } else if (line.startsWith("+++ b/")) {
      const filePath = line.slice(6).trim();
      // Only count as an addition if the preceding --- a/ was a different path
      // (or there was none). Same path = modification, not a new file.
      if (
        filePath !== lastMinusPath &&
        isClassifiableTestFile(filePath, defs)
      ) {
        const layer = classifyPath(filePath, defs);
        if (layer !== "unknown") {
          additions.push({ path: filePath, layer });
        }
      }
      lastMinusPath = null;
    } else if (!line.startsWith("---")) {
      // Any non-diff-header line resets the lastMinusPath guard so stray
      // --- a/ lines don't accidentally suppress unrelated +++ b/ lines.
      lastMinusPath = null;
    }
  }

  return additions;
}

// Checks each added file against directory-based prescriptions from test-system.md.
// When defsResult.source === "defaults", returns checked=false (test-system.md absent).
// Advisory only — never gates tasks or PRs.
export function checkConformance(
  additions: Array<{ path: string; layer: LayerName }>,
  defsResult: LoadDefsResult,
): ConformanceReport {
  if (defsResult.source === "defaults") {
    return { checked: false, deviations: [] };
  }

  const deviations: ConformanceDeviation[] = [];

  for (const addition of additions) {
    // Find a directory-based prescription: patterns that don't start with "*"
    // The first matching directory pattern defines the prescribed layer.
    let prescribedLayer: LayerName | null = null;
    let matchingPattern: string | null = null;

    for (const def of defsResult.defs) {
      for (const pattern of def.patterns) {
        if (!pattern.startsWith("*") && matchesGlob(addition.path, pattern)) {
          prescribedLayer = def.name;
          matchingPattern = pattern;
          break;
        }
      }
      if (prescribedLayer !== null) break;
    }

    if (
      prescribedLayer !== null &&
      matchingPattern !== null &&
      prescribedLayer !== addition.layer
    ) {
      deviations.push({
        module: matchingPattern,
        prescribed: prescribedLayer,
        observed: addition.layer,
      });
    }
  }

  return { checked: true, deviations };
}

export function parsePlanned(acBullets: string[]): ParsedDecision[] {
  return acBullets.map(parseSingleBullet);
}

function parseSingleBullet(bullet: string): ParsedDecision {
  const layers: LayerName[] = [];
  const added: string[] = [];
  const retired: string[] = [];

  // Extract layer name(s) from "Test decision (<layer> layer):"
  const layerMatch = bullet.match(/Test decision\s*\(([^)]+)\s+layer\)/i);
  if (layerMatch) {
    const rawLayers = layerMatch[1]
      .split(/[,&]+/)
      .map((s) => s.trim().toLowerCase());
    for (const l of rawLayers) {
      if (["unit", "integration", "smoke", "e2e"].includes(l)) {
        layers.push(l as LayerName);
      }
    }
  }

  // Split bullet into clauses on ";" separator
  // Remove the "Test decision (...): " prefix first
  const afterColon = bullet.replace(/^.*?:\s*/, "");
  const clauses = afterColon.split(/\s*;\s*/);

  for (const clause of clauses) {
    const trimmed = clause.trim();

    // "add <file> (<optional notes>)" — extract file paths
    if (/^add\s+/i.test(trimmed)) {
      const withoutAdd = trimmed.replace(/^add\s+/i, "");
      const files = extractFilePaths(withoutAdd);
      added.push(...files);
    } else if (/^(remove|retire)\s+/i.test(trimmed)) {
      // "remove <file>" or "retire <file>"
      const withoutVerb = trimmed.replace(/^(remove|retire)\s+/i, "");
      const files = extractFilePaths(withoutVerb);
      retired.push(...files);
    }
    // "no existing tests retired", "net-new module" — explicitly no retired tests; skip
  }

  return { layers, added, retired };
}

// Strip parenthetical notes, then extract file-path-shaped tokens.
function extractFilePaths(fragment: string): string[] {
  const paths: string[] = [];

  const withoutParens = fragment.replace(/\([^)]*\)/g, "").trim();

  const pathRegex = /[\w./-]+\.[\w.]+/g;
  const matches = withoutParens.match(pathRegex);
  if (matches) {
    for (const m of matches) {
      if (!m.endsWith(".")) {
        paths.push(m);
      }
    }
  }

  return paths;
}

type RunDeps = {
  fileReader: FileReader;
  args: string[];
  stdin?: string;
  log?: (msg: string) => void;
};

export async function run(deps: RunDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const { defs, source } = await loadDefs(deps.fileReader);
  log(`# Layer definitions source: ${source}`);

  const paths: string[] =
    deps.args.length > 0
      ? deps.args
      : (deps.stdin ?? "")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);

  for (const p of paths) {
    const layer = classifyPath(p, defs);
    log(`${layer}\t${p}`);
  }
}

// ─── Main (CLI invocation) ────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const stdinText = args.length === 0 ? await Bun.stdin.text() : undefined;

  await run({
    fileReader: (path) => Bun.file(path).text(),
    args,
    stdin: stdinText,
  });
}
