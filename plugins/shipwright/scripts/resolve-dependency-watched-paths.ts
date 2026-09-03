#!/usr/bin/env bun
// Dependency-manifest watched-path resolution (DBR-3.2).
//
// Given the raw text contents of a target repo's renovate.json and/or
// .github/dependabot.yml (or their absence), resolves the set of file paths
// that repo's PR review should treat as "dependency-manifest changes" — see
// plugins/shipwright/commands/review.md's Step 5.8, which invokes this
// script's CLI to build the watched-path set before comparing it against a
// PR's changed files (regardless of PR author).
//
// This is a best-effort scope narrowing, not a full Renovate/Dependabot
// config interpreter — see the comments on `narrowByRenovateManagers` and
// `dependabotUpdatesToPaths` below for exactly how much each config format
// is understood.
//
// Pure logic only — no filesystem or network I/O in the exported function;
// review.md's bash step reads the two files (if present) and passes their
// contents (or omits them) to the CLI below, mirroring
// compute-review-verdict.ts's / compute-unaddressed-findings.ts's
// inject-don't-reach-for-fs pattern.
//
// CLI:
//   bun run plugins/shipwright/scripts/resolve-dependency-watched-paths.ts \
//     '{"renovateJson":"{...}","dependabotYml":"updates:\n  - ..."}'
// or pipe the same JSON blob via stdin. Either field may be omitted/null
// when the corresponding file does not exist in the repo.

import * as yaml from "js-yaml";

// ─── Types ────────────────────────────────────────────────────────────────────

export type WatchedPathSource = "renovate" | "dependabot" | "both" | "fallback";

export type ResolveDependencyWatchedPathsInput = {
  /** Raw text contents of the target repo's renovate.json, or undefined if absent. */
  renovateJson: string | undefined;
  /** Raw text contents of the target repo's .github/dependabot.yml, or undefined if absent. */
  dependabotYml: string | undefined;
};

export type ResolveDependencyWatchedPathsResult = {
  /** De-duplicated list of watched file paths (repo-root-relative). */
  paths: string[];
  /** Which input(s) produced this set. */
  source: WatchedPathSource;
};

// ─── Universal fallback list ──────────────────────────────────────────────────
//
// Used when neither renovate.json nor dependabot.yml is present in the repo,
// and as the base set narrowed by ecosystem/manager mappings below.

export const UNIVERSAL_FALLBACK_PATHS: readonly string[] = [
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "go.mod",
  "go.sum",
  "Gemfile",
  "Gemfile.lock",
  "requirements.txt",
  "Pipfile",
  "Pipfile.lock",
  "pyproject.toml",
  "Cargo.toml",
  "Cargo.lock",
];

// ─── Ecosystem <-> manifest-file mapping ───────────────────────────────────────
//
// Shared between the Renovate `managers` narrowing and the Dependabot
// `package-ecosystem` mapping below — the two config formats name the same
// underlying package-manager concept with different vocabularies (Renovate's
// "manager" ids vs. Dependabot's "package-ecosystem" ids), so each entry here
// lists both names where they differ, pointing at the same manifest files.

type EcosystemEntry = {
  renovateManagers: string[];
  dependabotEcosystems: string[];
  manifestFiles: string[];
};

const ECOSYSTEMS: EcosystemEntry[] = [
  {
    renovateManagers: ["npm"],
    dependabotEcosystems: ["npm"],
    manifestFiles: [
      "package.json",
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lock",
      "bun.lockb",
    ],
  },
  {
    renovateManagers: ["bundler"],
    dependabotEcosystems: ["bundler"],
    manifestFiles: ["Gemfile", "Gemfile.lock"],
  },
  {
    renovateManagers: ["pip_requirements", "pip_setup", "pipenv", "poetry"],
    dependabotEcosystems: ["pip"],
    manifestFiles: [
      "requirements.txt",
      "Pipfile",
      "Pipfile.lock",
      "pyproject.toml",
    ],
  },
  {
    renovateManagers: ["gomod"],
    dependabotEcosystems: ["gomod"],
    manifestFiles: ["go.mod", "go.sum"],
  },
  {
    renovateManagers: ["cargo"],
    dependabotEcosystems: ["cargo"],
    manifestFiles: ["Cargo.toml", "Cargo.lock"],
  },
  {
    renovateManagers: ["github-actions"],
    dependabotEcosystems: ["github-actions"],
    // A directory-prefix entry (trailing `/`, no glob characters), not a
    // bare filename — review.md's Step 5.8 comparison rule matches this
    // against any changed file whose path starts with the prefix (e.g.
    // `.github/workflows/ci.yml`). Glob-style entries like
    // `.github/workflows/*.yml` were tried here previously, but Step 5.8's
    // matcher only understands exact-path and bare-basename matches — a
    // path containing both `/` and `*` could never match either rule, so
    // github-actions detection was silently dead. Directory join below is
    // still skipped for this ecosystem's `.github/`-rooted entry — see
    // resolveFromDependabotYml.
    manifestFiles: [".github/workflows/"],
  },
];

// ─── renovate.json parsing ──────────────────────────────────────────────────
//
// Best-effort scope narrowing, not a full Renovate config interpreter: only
// the top-level `managers` array is consulted. If `managers` is absent,
// Renovate's own default behavior is "detect all supported manifests" — so
// an unrestricted renovate.json (or one that fails to parse) is treated as
// watching the full universal fallback list, since its presence alone does
// not narrow scope. `matchPackageNames`/`packageRules[].matchPackageNames`
// scope individual *packages* within an already-detected manifest, not which
// manifest *files* are watched, so they do not further narrow the path set
// this function resolves (see the module comment in review.md's Step 5.8 for
// why: this is a file-level watch list, not a package-level one).
function resolveFromRenovateJson(renovateJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(renovateJson);
  } catch {
    return [...UNIVERSAL_FALLBACK_PATHS];
  }

  const managers =
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { managers?: unknown }).managers)
      ? ((parsed as { managers: unknown[] }).managers.filter(
          (m): m is string => typeof m === "string",
        ) as string[])
      : undefined;

  if (!managers || managers.length === 0) {
    return [...UNIVERSAL_FALLBACK_PATHS];
  }

  const narrowed = new Set<string>();
  for (const manager of managers) {
    const entry = ECOSYSTEMS.find((e) => e.renovateManagers.includes(manager));
    if (entry) {
      for (const file of entry.manifestFiles) narrowed.add(file);
    }
  }

  // An explicit `managers` array naming only unrecognized manager ids (not in
  // the ECOSYSTEMS table above) would otherwise narrow to an empty set —
  // degrade to the full fallback list rather than watching nothing.
  return narrowed.size > 0 ? [...narrowed] : [...UNIVERSAL_FALLBACK_PATHS];
}

// ─── dependabot.yml parsing ──────────────────────────────────────────────────
//
// Parses the top-level `updates[]` array's `package-ecosystem` and
// `directory` fields. Each ecosystem maps to its manifest filename(s) via
// the shared ECOSYSTEMS table above; `directory` (when not "/" or empty) is
// joined as a path prefix, e.g. `directory: "/backend"` + `npm` ->
// `backend/package.json`. Unrecognized ecosystems are skipped (not folded
// into the fallback list) since an explicit dependabot.yml is itself
// authoritative about which ecosystems this repo watches — unlike
// renovate.json's un-narrowed case, a dependabot.yml with `updates: []` (or
// entries this parser doesn't recognize) legitimately watches nothing, and
// this function returns an empty path set for it rather than degrading to the
// universal fallback list (which would spuriously trigger review.md's Step 5.8
// dependency-risk analysis on manifests the repo demonstrably does not watch).
//
// The universal fallback is reserved for the cases where the config could not
// be *understood* at all — unparseable YAML, a non-object document, or a
// missing/non-array `updates` key. Those are "we don't know what this repo
// watches", which is materially different from "this repo watches nothing".
function resolveFromDependabotYml(dependabotYml: string): string[] {
  let parsed: unknown;
  try {
    parsed = yaml.load(dependabotYml);
  } catch {
    return [...UNIVERSAL_FALLBACK_PATHS];
  }

  if (!parsed || typeof parsed !== "object") {
    return [...UNIVERSAL_FALLBACK_PATHS];
  }

  const updates = (parsed as { updates?: unknown }).updates;
  if (!Array.isArray(updates)) {
    return [...UNIVERSAL_FALLBACK_PATHS];
  }

  const paths = new Set<string>();
  for (const update of updates) {
    if (!update || typeof update !== "object") continue;
    const ecosystem = (update as { "package-ecosystem"?: unknown })[
      "package-ecosystem"
    ];
    if (typeof ecosystem !== "string") continue;

    const entry = ECOSYSTEMS.find((e) =>
      e.dependabotEcosystems.includes(ecosystem),
    );
    if (!entry) continue;

    const rawDirectory = (update as { directory?: unknown }).directory;
    const directory = typeof rawDirectory === "string" ? rawDirectory : "/";
    const prefix = normalizeDirectoryPrefix(directory);

    for (const file of entry.manifestFiles) {
      // github-actions' directory-prefix entry is already repo-root-anchored
      // (.github/workflows/) regardless of `directory` — Dependabot
      // itself does not relocate the workflows directory per-entry.
      if (file.startsWith(".github/")) {
        paths.add(file);
        continue;
      }
      paths.add(prefix ? `${prefix}/${file}` : file);
    }
  }

  // No universal-fallback degradation here: an `updates: []` array, or one
  // whose every entry names an ecosystem this parser doesn't recognize, is an
  // authoritative "watches nothing" — see the comment above this function.
  return [...paths];
}

function normalizeDirectoryPrefix(directory: string): string {
  const trimmed = directory.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed;
}

// ─── resolveDependencyWatchedPaths ─────────────────────────────────────────────

export function resolveDependencyWatchedPaths(
  input: ResolveDependencyWatchedPathsInput,
): ResolveDependencyWatchedPathsResult {
  const hasRenovate =
    typeof input.renovateJson === "string" && input.renovateJson.length > 0;
  const hasDependabot =
    typeof input.dependabotYml === "string" && input.dependabotYml.length > 0;

  if (!hasRenovate && !hasDependabot) {
    return { paths: [...UNIVERSAL_FALLBACK_PATHS], source: "fallback" };
  }

  if (hasRenovate && !hasDependabot) {
    return {
      paths: resolveFromRenovateJson(input.renovateJson as string),
      source: "renovate",
    };
  }

  if (!hasRenovate && hasDependabot) {
    return {
      paths: resolveFromDependabotYml(input.dependabotYml as string),
      source: "dependabot",
    };
  }

  const renovatePaths = resolveFromRenovateJson(input.renovateJson as string);
  const dependabotPaths = resolveFromDependabotYml(
    input.dependabotYml as string,
  );
  const union = new Set([...renovatePaths, ...dependabotPaths]);
  return { paths: [...union], source: "both" };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

type CliInput = {
  renovateJson?: string | null;
  dependabotYml?: string | null;
};

function parseCliInput(raw: string): ResolveDependencyWatchedPathsInput {
  const parsed = JSON.parse(raw) as CliInput;
  return {
    renovateJson:
      typeof parsed.renovateJson === "string" ? parsed.renovateJson : undefined,
    dependabotYml:
      typeof parsed.dependabotYml === "string"
        ? parsed.dependabotYml
        : undefined,
  };
}

if (import.meta.main) {
  const arg = process.argv[2];
  const raw = arg && arg.length > 0 ? arg : await Bun.stdin.text();
  const input = parseCliInput(raw);
  const result = resolveDependencyWatchedPaths(input);
  console.log(JSON.stringify(result));
}
