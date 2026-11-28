/**
 * plugins/shipwright/scripts/entropy-baseline.ts
 *
 * Built-in code-quality tooling checks for the entropy patrol (RDY-3.1). A fixed
 * baseline that runs alongside each repo's own principles and needs no per-repo
 * config: linter, formatter, type checker, pre-commit hooks, and CI running lint
 * and type check. These are the entropy-owned checks in readiness-catalogue.ts.
 *
 * Exports: detectToolchain, scanBaseline, planBaselineTasks, isoWeek
 * CLI:     bun entropy-baseline.ts scan <repoDir>   → prints the findings as JSON
 *
 * Deterministic: same repo contents → same findings, so an unchanged repo leaves
 * docs/patrols/entropy.md unchanged and queues nothing new.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Ecosystem = "node" | "python" | "go" | "rust";
export type BaselineRoute = "auto" | "review";

export interface BaselineFinding {
  ruleId: string;
  severity: "high" | "medium" | "low";
  category: "tooling";
  file: string;
  line: null;
  symbol: string;
  description: string;
  effort: "trivial" | "small" | "medium";
  /** auto: add config / wire into CI. review: stricter mode that may break the build. */
  route: BaselineRoute;
  ecosystem: Ecosystem;
}

export interface Toolchain {
  ecosystem: Ecosystem;
  typescript: boolean;
}

const read = (dir: string, rel: string): string | null => {
  const p = join(dir, rel);
  return existsSync(p) ? readFileSync(p, "utf-8") : null;
};

const anyExists = (dir: string, rels: string[]) =>
  rels.some((r) => existsSync(join(dir, r)));

const readJson = (dir: string, rel: string): Record<string, unknown> | null => {
  const raw = read(dir, rel);
  if (raw === null) return null;
  try {
    // tsconfig allows comments and trailing commas
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[\s,{[])\/\/.*$/gm, "$1")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch {
    return null;
  }
};

/** Same file-based signals as references/toolchain-patterns.md, config-file tier. */
export function detectToolchain(dir: string): Toolchain | null {
  if (existsSync(join(dir, "package.json"))) {
    const pkg = readJson(dir, "package.json") ?? {};
    const deps = {
      ...(pkg.dependencies as object),
      ...(pkg.devDependencies as object),
    };
    return {
      ecosystem: "node",
      typescript: existsSync(join(dir, "tsconfig.json")) || "typescript" in deps,
    };
  }
  if (anyExists(dir, ["pyproject.toml", "requirements.txt", "setup.py"]))
    return { ecosystem: "python", typescript: false };
  if (existsSync(join(dir, "go.mod")))
    return { ecosystem: "go", typescript: false };
  if (existsSync(join(dir, "Cargo.toml")))
    return { ecosystem: "rust", typescript: false };
  return null;
}

const pyproject = (dir: string) => read(dir, "pyproject.toml") ?? "";

function hasLinter(dir: string, t: Toolchain): boolean {
  switch (t.ecosystem) {
    case "node":
      return (
        anyExists(dir, [
          "biome.json",
          "biome.jsonc",
          "eslint.config.js",
          "eslint.config.mjs",
          "eslint.config.cjs",
          "eslint.config.ts",
          ".eslintrc",
          ".eslintrc.js",
          ".eslintrc.cjs",
          ".eslintrc.json",
          ".eslintrc.yml",
          ".eslintrc.yaml",
          "oxlintrc.json",
          ".oxlintrc.json",
        ]) || "eslintConfig" in (readJson(dir, "package.json") ?? {})
      );
    case "python":
      return (
        anyExists(dir, ["ruff.toml", ".ruff.toml", ".flake8", ".pylintrc"]) ||
        /\[tool\.(ruff|pylint|flake8)/.test(pyproject(dir))
      );
    case "go":
      return anyExists(dir, [
        ".golangci.yml",
        ".golangci.yaml",
        ".golangci.toml",
        ".golangci.json",
      ]);
    case "rust":
      return true; // clippy ships with the toolchain
  }
}

function hasFormatter(dir: string, t: Toolchain): boolean {
  switch (t.ecosystem) {
    case "node":
      return (
        anyExists(dir, [
          "biome.json",
          "biome.jsonc",
          "dprint.json",
          ".prettierrc",
          ".prettierrc.json",
          ".prettierrc.yml",
          ".prettierrc.yaml",
          ".prettierrc.js",
          ".prettierrc.cjs",
          ".prettierrc.mjs",
          "prettier.config.js",
          "prettier.config.mjs",
          "prettier.config.cjs",
          ".editorconfig-checker.json",
        ]) || "prettier" in (readJson(dir, "package.json") ?? {})
      );
    case "python":
      return (
        anyExists(dir, ["ruff.toml", ".ruff.toml"]) ||
        /\[tool\.(ruff|black|yapf)/.test(pyproject(dir))
      );
    case "go":
    case "rust":
      return true; // gofmt / rustfmt ship with the toolchain
  }
}

function hasTypeChecker(dir: string, t: Toolchain): boolean | null {
  switch (t.ecosystem) {
    case "node":
      return t.typescript ? existsSync(join(dir, "tsconfig.json")) : null;
    case "python":
      return (
        anyExists(dir, ["mypy.ini", ".mypy.ini", "pyrightconfig.json"]) ||
        /\[tool\.(mypy|pyright)/.test(pyproject(dir))
      );
    default:
      return null; // go / rust: the compiler is the type checker
  }
}

function hasPreCommit(dir: string): boolean {
  return (
    anyExists(dir, [
      ".pre-commit-config.yaml",
      ".husky",
      "lefthook.yml",
      "lefthook.yaml",
      ".lefthook.yml",
      "lefthook.json",
    ]) || "simple-git-hooks" in (readJson(dir, "package.json") ?? {})
  );
}

function workflowText(dir: string): string {
  const wf = join(dir, ".github", "workflows");
  if (!existsSync(wf)) return "";
  return readdirSync(wf)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => readFileSync(join(wf, f), "utf-8"))
    .join("\n");
}

const LINT_CMD =
  /\b(lint|biome (check|ci)|eslint|oxlint|ruff|flake8|pylint|golangci-lint|clippy)\b/i;
const TYPE_CMD =
  /\b(typecheck|type-check|tsc|mypy|pyright|go vet|go build|cargo (check|build|clippy))\b/i;

/** tsconfig present without `strict: true` → a stricter mode is available. */
function tsStrictOff(dir: string): boolean {
  const cfg = readJson(dir, "tsconfig.json");
  if (!cfg) return false;
  const co = (cfg.compilerOptions ?? {}) as Record<string, unknown>;
  return co.strict !== true && !("extends" in cfg);
}

export function scanBaseline(dir: string): BaselineFinding[] {
  const t = detectToolchain(dir);
  if (!t) return [];
  const eco = t.ecosystem;
  const out: BaselineFinding[] = [];
  const add = (
    f: Omit<BaselineFinding, "category" | "line" | "ecosystem">,
  ) => out.push({ ...f, category: "tooling", line: null, ecosystem: eco });

  const linter = hasLinter(dir, t);
  const typer = hasTypeChecker(dir, t);

  if (!linter)
    add({
      ruleId: "tooling_linter",
      severity: "medium",
      file: ".",
      symbol: "linter",
      description: `No linter configured for the ${eco} toolchain`,
      effort: "small",
      route: "auto",
    });
  if (!hasFormatter(dir, t))
    add({
      ruleId: "tooling_formatter",
      severity: "low",
      file: ".",
      symbol: "formatter",
      description: `No formatter configured for the ${eco} toolchain`,
      effort: "small",
      route: "auto",
    });
  if (typer === false)
    add({
      ruleId: "tooling_type_checker",
      severity: "medium",
      file: ".",
      symbol: "type-checker",
      description: `No type checker configured for the ${eco} toolchain`,
      effort: "small",
      route: "auto",
    });
  if (!hasPreCommit(dir))
    add({
      ruleId: "tooling_pre_commit",
      severity: "low",
      file: ".",
      symbol: "pre-commit",
      description: "No pre-commit hooks configured",
      effort: "trivial",
      route: "auto",
    });

  const ci = workflowText(dir);
  const missing: string[] = [];
  if (!LINT_CMD.test(ci)) missing.push("lint");
  if (typer !== null && !TYPE_CMD.test(ci)) missing.push("type check");
  if (missing.length)
    add({
      ruleId: "tooling_ci_lint_typecheck",
      severity: "medium",
      file: ".github/workflows",
      symbol: "ci-lint-typecheck",
      description: `CI does not run ${missing.join(" and ")}`,
      effort: "small",
      route: "auto",
    });

  if (t.typescript && typer !== false && tsStrictOff(dir))
    add({
      ruleId: "tooling_stricter_mode",
      severity: "low",
      file: "tsconfig.json",
      symbol: "strict",
      description:
        'TypeScript "strict" mode is off; enabling it may break the build',
      effort: "medium",
      route: "review",
    });

  return out;
}

/** ISO-8601 week, `YYYY-Www`, for task ids. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export interface PlannedTask {
  id: string;
  title: string;
  source: "entropy-fix";
  originKind: "cron";
  originRef: "entropy-patrol";
  repo: string;
  kind: "dev";
  branch: string;
  layer: "Shared";
  status: "pending" | "blocked";
  hitl: false;
  blockedReason?: string;
  description: string;
}

/**
 * One task per baseline rule. A rule whose id already appears in an active
 * (pending / in_progress / blocked) task is skipped, so re-running on an
 * unchanged repo queues nothing.
 */
export function planBaselineTasks(
  findings: BaselineFinding[],
  repo: string,
  week: string,
  activeTaskIds: string[],
): PlannedTask[] {
  const slug = (repo.split("/").pop() ?? repo).toLowerCase();
  const tasks: PlannedTask[] = [];
  for (const f of findings) {
    const id = `entropy-${f.ruleId}-${slug}-${week}`;
    const prefix = `entropy-${f.ruleId}-${slug}-`;
    if (
      activeTaskIds.some(
        (a) =>
          a === id ||
          (a.startsWith(prefix) &&
            /^\d{4}-W\d{2}$/.test(a.slice(prefix.length))),
      )
    )
      continue;
    const base = {
      id,
      title: `Entropy fix: ${f.description}`,
      source: "entropy-fix" as const,
      originKind: "cron" as const,
      originRef: "entropy-patrol" as const,
      repo,
      kind: "dev" as const,
      branch: `fix/entropy-${f.ruleId.replace(/_/g, "-")}`,
      layer: "Shared" as const,
      hitl: false as const,
      description:
        `Entropy patrol finding: ${f.ruleId} — ${f.description} (${f.severity})\n\n` +
        `Fix guidance: add the ${f.symbol} setup that matches the detected ${f.ecosystem} toolchain; ` +
        `reuse commands the repo already has.\n\n` +
        `Rule: ${f.ruleId} | Severity: ${f.severity} | Domain: tooling | Route: ${f.route}`,
    };
    tasks.push(
      f.route === "review"
        ? {
            ...base,
            status: "blocked",
            blockedReason: `needs-review: ${f.description}. Enable it now and fix the resulting errors, or defer?`,
          }
        : { ...base, status: "pending" },
    );
  }
  return tasks;
}

if (import.meta.main) {
  const [cmd, dir] = process.argv.slice(2);
  if (cmd !== "scan" || !dir) {
    console.error("Usage: bun entropy-baseline.ts scan <repoDir>");
    process.exit(2);
  }
  console.log(JSON.stringify(scanBaseline(dir), null, 2));
}
