/**
 * plugins/shipwright/scripts/readiness-detectors.ts
 *
 * File-based readiness detectors: one pure function per RDY-1.1 catalogue
 * check that can be answered from a repo checkout alone. Each returns
 * `pass | fail | n/a` (`n/a` = the check does not apply to the detected
 * toolchain(s), e.g. a type checker for Go, or any language-specific check in a
 * repo with no recognised toolchain — never an assumption of TypeScript).
 *
 * Toolchain detection mirrors references/toolchain-patterns.md: package.json,
 * Cargo.toml, go.mod, Maven/Gradle, Python, Ruby, Makefile.
 *
 * Detectors read ONLY through the injected `ReadinessReader`, so they are
 * testable with fixture trees. Deterministic: no clock, no LLM, no real I/O,
 * and results do not depend on the order the reader lists files in.
 *
 * Exports:
 *   ReadinessReader, Detector, DETECTORS, runDetectors, detectToolchains
 *   plus one `detect*` function per check.
 *
 * Not covered (need GitHub API / task store, not a checkout): default-branch-protected,
 * docs-fresh, no-critical-security-findings, no-high-entropy-findings,
 * test-suite-speed-budget, owner-crons-running, no-stale-consolidation-pattern.
 */
import type { CheckResult } from "./readiness-catalogue.ts";

/** Read-only view of a repo checkout. Paths are repo-relative, POSIX-style. */
export interface ReadinessReader {
  /** Every file path in the checkout (any order). */
  listFiles(): readonly string[];
  /** File contents, or undefined when absent/unreadable. */
  read(path: string): string | undefined;
}

export type Detector = (reader: ReadinessReader) => CheckResult;

export type Toolchain = "node" | "rust" | "go" | "java" | "python" | "ruby" | "make";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
]);

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|py|rb|scala|cs|php|swift|c|cc|cpp|h)$/;
const GENERATED = /(\.d\.ts|\.min\.js|\.pb\.go|_pb2\.py|\.generated\.\w+)$|(^|\/)generated\//;

// ---------- helpers ----------

/** Sorted, de-duplicated, normalised file list with vendored/build dirs removed. */
function files(r: ReadinessReader): string[] {
  const out = new Set<string>();
  for (const raw of r.listFiles()) {
    const p = raw.replace(/^\.\//, "");
    if (p.split("/").some((seg) => IGNORED_DIRS.has(seg))) continue;
    out.add(p);
  }
  return [...out].sort();
}

const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

const hasBase = (fs: readonly string[], re: RegExp): boolean => fs.some((f) => re.test(base(f)));

const hasPath = (fs: readonly string[], re: RegExp): boolean => fs.some((f) => re.test(f));

function text(r: ReadinessReader, paths: readonly string[]): string {
  return paths.map((p) => r.read(p) ?? "").join("\n");
}

const rootDoc = (fs: readonly string[], re: RegExp): string[] =>
  fs.filter((f) => !f.includes("/") && re.test(f));

export function detectToolchains(r: ReadinessReader): Toolchain[] {
  const fs = files(r);
  const found: Toolchain[] = [];
  const add = (t: Toolchain, re: RegExp) => {
    if (hasBase(fs, re)) found.push(t);
  };
  add("node", /^package\.json$/);
  add("rust", /^Cargo\.toml$/);
  add("go", /^go\.mod$/);
  add("java", /^(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/);
  add("python", /^(pyproject\.toml|requirements[\w.-]*\.txt|setup\.py|setup\.cfg|Pipfile)$/);
  add("ruby", /^(Gemfile|[\w.-]+\.gemspec)$/);
  add("make", /^Makefile$/);
  return found;
}

/** Combine per-toolchain results: any pass wins, else any fail, else n/a. */
function combine(results: readonly CheckResult[]): CheckResult {
  if (results.includes("pass")) return "pass";
  if (results.includes("fail")) return "fail";
  return "n/a";
}

type PerToolchain = Partial<Record<Toolchain, (r: ReadinessReader, fs: string[]) => CheckResult>>;

/** Run per-toolchain handlers; toolchains with no handler contribute n/a. */
function perToolchain(r: ReadinessReader, handlers: PerToolchain): CheckResult {
  const fs = files(r);
  return combine(detectToolchains(r).map((t) => handlers[t]?.(r, fs) ?? "n/a"));
}

const yn = (b: boolean): CheckResult => (b ? "pass" : "fail");

const pyproject = (r: ReadinessReader, fs: string[]): string =>
  text(
    r,
    fs.filter((f) => base(f) === "pyproject.toml"),
  );

const pkgJson = (r: ReadinessReader, fs: string[]): string =>
  text(
    r,
    fs.filter((f) => base(f) === "package.json"),
  );

const buildFiles = (r: ReadinessReader, fs: string[]): string =>
  text(
    r,
    fs.filter((f) => /^(pom\.xml|build\.gradle(\.kts)?)$/.test(base(f))),
  );

const CI_FILE =
  /^(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|\.circleci\/config\.yml|azure-pipelines\.yml|bitbucket-pipelines\.yml|Jenkinsfile)$/;

function ciFiles(fs: readonly string[]): string[] {
  return fs.filter((f) => CI_FILE.test(f));
}

const ciText = (r: ReadinessReader): string => text(r, ciFiles(files(r)));

const isSource = (f: string): boolean => SOURCE_EXT.test(f) && !GENERATED.test(f);

function isTestFile(r: ReadinessReader, f: string): boolean {
  if (!isSource(f)) return false;
  if (
    /(\.|_)(test|spec)\.[a-z]+$/.test(f) ||
    /(^|\/)test_[^/]+\.py$/.test(f) ||
    /_test\.(go|py)$/.test(f) ||
    /_spec\.rb$/.test(f) ||
    /(^|\/)(tests?|__tests__|spec)\//.test(f) ||
    /(^|\/)src\/test\//.test(f) ||
    /Tests?\.(java|kt|cs)$/.test(f)
  ) {
    return true;
  }
  // Rust unit tests live inline in source files.
  return f.endsWith(".rs") && /#\[(cfg\(test\)|test)\]/.test(r.read(f) ?? "");
}

// ---------- Level 1 ----------

export const detectReadmePresent: Detector = (r) =>
  yn(rootDoc(files(r), /^readme(\.[a-z]+)?$/i).length > 0);

export const detectLinterConfigured: Detector = (r) =>
  perToolchain(r, {
    node: (rd, fs) =>
      yn(
        hasBase(
          fs,
          /^(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.[a-z]+)?|biome\.jsonc?|\.oxlintrc\.json|oxlint\.json|deno\.jsonc?|\.xo-config(\.[a-z]+)?)$/,
        ) || /"(eslintConfig|eslint|@biomejs\/biome|oxlint|xo)"/.test(pkgJson(rd, fs)),
      ),
    go: (_rd, fs) => yn(hasBase(fs, /^\.golangci\.(ya?ml|toml|json)$/)),
    rust: (rd, fs) =>
      yn(hasBase(fs, /^\.?clippy\.toml$/) || /clippy/.test(text(rd, ciFiles(fs)))),
    python: (rd, fs) =>
      yn(
        hasBase(fs, /^(ruff|\.ruff)\.toml$|^\.flake8$|^\.?pylintrc$/) ||
          /\[tool\.(ruff|pylint|flake8)/.test(pyproject(rd, fs)),
      ),
    ruby: (_rd, fs) => yn(hasBase(fs, /^\.rubocop\.yml$/)),
    java: (rd, fs) =>
      yn(
        hasPath(fs, /(^|\/)(checkstyle|pmd|spotbugs)[\w.-]*\.xml$/) ||
          /checkstyle|pmd|spotbugs|detekt/.test(buildFiles(rd, fs)),
      ),
  });

export const detectTypeCheckerConfigured: Detector = (r) =>
  perToolchain(r, {
    node: (rd, fs) => {
      if (hasBase(fs, /^tsconfig(\.[\w-]+)?\.json$/)) return "pass";
      // Plain JavaScript: only fail if TypeScript is declared or its sources exist without a tsconfig.
      const usesTs =
        /"typescript"/.test(pkgJson(rd, fs)) ||
        fs.some((f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts"));
      return usesTs ? "fail" : "n/a";
    },
    python: (rd, fs) =>
      yn(
        hasBase(fs, /^(mypy\.ini|\.mypy\.ini|pyrightconfig\.json|pytype\.cfg)$/) ||
          /\[tool\.(mypy|pyright|pytype)/.test(pyproject(rd, fs)) ||
          /\[mypy/.test(text(rd, fs.filter((f) => base(f) === "setup.cfg"))),
      ),
    // Ruby has only optional checkers: pass when one is present, otherwise n/a.
    ruby: (_rd, fs) => (hasPath(fs, /(^|\/)(sorbet\/config|Steepfile)$/) ? "pass" : "n/a"),
    // Go, Rust, Java: the compiler type-checks; there is nothing to configure -> n/a (default).
  });

export const detectUnitTestsExist: Detector = (r) => yn(files(r).some((f) => isTestFile(r, f)));

// ---------- Level 2 ----------

export const detectAgentInstructionsPresent: Detector = (r) =>
  yn(rootDoc(files(r), /^(AGENTS|CLAUDE)\.md$/).length > 0);

const BUILD_CMD =
  /\b(npm|yarn|pnpm|bun|cargo|go|make|mvn|gradle|\.\/gradlew|gradlew|task|just|rake|bundle exec rake|python -m build|poetry|uv)\s+(run\s+)?(build|compile|install|package|assemble)\b/i;
const TEST_CMD =
  /\b(npm|yarn|pnpm|bun|cargo|go|make|mvn|gradle|\.\/gradlew|gradlew|task|just|rake|bundle exec rake|poetry run|uv run)\s+(run\s+)?(test|tests|nextest|check)\b|\b(pytest|rspec|vitest|jest|tox)\b/i;

export const detectBuildTestDocumented: Detector = (r) => {
  const fs = files(r);
  const docs = fs.filter(
    (f) =>
      rootDoc([f], /^(readme|agents|claude|contributing|development)(\.[a-z]+)?$/i).length > 0 ||
      /^docs\/[^/]+\.md$/i.test(f),
  );
  const t = text(r, docs);
  return yn(BUILD_CMD.test(t) && TEST_CMD.test(t));
};

export const detectDependenciesPinned: Detector = (r) =>
  perToolchain(r, {
    node: (_rd, fs) =>
      yn(hasBase(fs, /^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/)),
    rust: (_rd, fs) => yn(hasBase(fs, /^Cargo\.lock$/)),
    // go.mod pins exact module versions; go.sum adds checksums.
    go: () => "pass",
    python: (rd, fs) =>
      yn(
        hasBase(fs, /^(poetry\.lock|uv\.lock|Pipfile\.lock|pdm\.lock)$/) ||
          fs.some(
            (f) =>
              /^requirements[\w.-]*\.txt$/.test(base(f)) && /^[\w.-]+==/m.test(rd.read(f) ?? ""),
          ),
      ),
    ruby: (_rd, fs) => yn(hasBase(fs, /^Gemfile\.lock$/)),
    // Gradle has opt-in lockfiles; Maven has none (versions are pinned in the pom) -> n/a.
    java: (_rd, fs) =>
      hasBase(fs, /^build\.gradle(\.kts)?$/) ? yn(hasBase(fs, /^gradle\.lockfile$/)) : "n/a",
  });

export const detectFormatterConfigured: Detector = (r) =>
  perToolchain(r, {
    node: (rd, fs) =>
      yn(
        hasBase(
          fs,
          /^(biome\.jsonc?|\.prettierrc(\.[a-z]+)?|prettier\.config\.[cm]?[jt]s|dprint\.json|\.dprint\.json|deno\.jsonc?)$/,
        ) || /"(prettier|@biomejs\/biome|dprint)"/.test(pkgJson(rd, fs)),
      ),
    // gofmt is the canonical formatter and needs no configuration.
    go: () => "pass",
    rust: (rd, fs) =>
      yn(hasBase(fs, /^\.?rustfmt\.toml$/) || /cargo fmt/.test(text(rd, ciFiles(fs)))),
    python: (rd, fs) =>
      yn(
        hasBase(fs, /^(ruff|\.ruff)\.toml$|^\.style\.yapf$/) ||
          /\[tool\.(black|ruff|yapf|isort)/.test(pyproject(rd, fs)),
      ),
    ruby: (_rd, fs) => yn(hasBase(fs, /^\.rubocop\.yml$/)),
    java: (rd, fs) => yn(/spotless|google-java-format|ktfmt|ktlint/.test(buildFiles(rd, fs))),
  });

export const detectPreCommitConfigured: Detector = (r) => {
  const fs = files(r);
  return yn(
    hasBase(fs, /^(\.pre-commit-config\.ya?ml|\.?lefthook\.ya?ml|\.huskyrc(\.[a-z]+)?)$/) ||
      hasPath(fs, /^\.husky\//) ||
      /"(simple-git-hooks|lint-staged|husky|lefthook)"/.test(pkgJson(r, fs)),
  );
};

export const detectToolVersionsPinned: Detector = (r) => {
  const fs = files(r);
  return yn(
    hasBase(
      fs,
      /^(\.tool-versions|\.?mise\.toml|\.nvmrc|\.node-version|\.python-version|\.ruby-version|\.go-version|\.sdkmanrc|rust-toolchain(\.toml)?|flake\.nix|devcontainer\.json|\.devcontainer\.json|Dockerfile(\.[\w-]+)?|[\w-]+\.Dockerfile|\.java-version)$/,
    ) || hasPath(fs, /^\.devcontainer\//),
  );
};

export const detectCodeownersPresent: Detector = (r) =>
  yn(files(r).some((f) => /^(\.github\/|docs\/)?CODEOWNERS$/.test(f)));

// ---------- Level 3 ----------

const LINT_CI = /\b(lint|eslint|oxlint|biome\s+(check|lint|ci)|golangci-lint|clippy|ruff|flake8|pylint|rubocop|checkstyle|detekt)\b/i;
const TYPECHECK_CI = /\b(tsc|tsgo|vue-tsc|typecheck|type-check|type_check|mypy|pyright|pytype|srb\s+tc|steep\s+check)\b/i;

export const detectCiRunsLintTypecheck: Detector = (r) => {
  const toolchains = detectToolchains(r);
  if (toolchains.length === 0) return "n/a";
  const ci = ciText(r);
  const needsTypecheck = detectTypeCheckerConfigured(r) !== "n/a";
  return yn(LINT_CI.test(ci) && (!needsTypecheck || TYPECHECK_CI.test(ci)));
};

const TEST_CI =
  /\b(npm|yarn|pnpm|bun)\s+(run\s+)?test\b|\bbun\s+test\b|\bgo\s+test\b|\bcargo\s+(test|nextest)\b|\bpytest\b|\b(mvn|\.\/mvnw)\b[^\n]*\b(test|verify)\b|\bgradlew?\b[^\n]*\b(test|check|build)\b|\brspec\b|\brake\s+(test|spec)\b|\bmake\s+(test|check|ci)\b|\btask\s+(test|ci)\b|\b(vitest|jest|playwright\s+test)\b/i;

export const detectCiRunsTests: Detector = (r) => yn(TEST_CI.test(ciText(r)));

export const detectSmokeE2eLayerExists: Detector = (r) =>
  yn(
    files(r).some(
      (f) =>
        (isSource(f) &&
          (/(^|\/)(e2e|smoke|end-to-end|cypress)\//i.test(f) ||
            /[._-](e2e|smoke)[._-]/i.test(base(f)) ||
            /\.(e2e|smoke)\.[a-z]+$/i.test(base(f)))) ||
        /^(playwright|cypress)\.config\.[cm]?[jt]s$/.test(base(f)),
    ),
  );

export const detectSecretScanningCi: Detector = (r) =>
  yn(
    /\b(gitleaks|trufflehog|detect-secrets|git-secrets|ggshield|secret[-_ ]?scan(ning)?|secretlint)\b/i.test(
      ciText(r),
    ),
  );

const DEP_SCAN_CI =
  /\b(npm audit|yarn audit|pnpm audit|bun audit|cargo audit|cargo deny|govulncheck|pip-audit|bundler-audit|osv-scanner|snyk|dependency-review-action|trivy|grype)\b/i;

export const detectDependencyAutomation: Detector = (r) => {
  const fs = files(r);
  return yn(
    hasPath(fs, /^\.github\/dependabot\.ya?ml$/) ||
      hasBase(fs, /^(\.?renovate(\.json5?)?|\.renovaterc(\.json)?)$/) ||
      /"renovate"/.test(pkgJson(r, fs)) ||
      DEP_SCAN_CI.test(ciText(r)),
  );
};

/** Dependency/manifest text across toolchains, for library-presence checks. */
function manifestText(r: ReadinessReader, fs: string[]): string {
  return text(
    r,
    fs.filter((f) =>
      /^(package\.json|go\.mod|Cargo\.toml|requirements[\w.-]*\.txt|pyproject\.toml|Pipfile|Gemfile|pom\.xml|build\.gradle(\.kts)?|\.env\.(example|sample))$/.test(
        base(f),
      ),
    ),
  );
}

function libraryCheck(r: ReadinessReader, re: RegExp, extra?: (fs: string[]) => boolean): CheckResult {
  const fs = files(r);
  if (detectToolchains(r).length === 0) return "n/a";
  return yn(re.test(manifestText(r, fs)) || (extra?.(fs) ?? false));
}

export const detectStructuredLogging: Detector = (r) =>
  libraryCheck(
    r,
    /\b(pino|winston|bunyan|roarr|zap|zerolog|logrus|structlog|loguru|python-json-logger|semantic_logger|lograge|ougai|logstash-logback-encoder|log4j-layout-template-json|tracing-subscriber|slog)\b/i,
    // Go's stdlib slog is imported, not declared in go.mod.
    (fs) => fs.some((f) => f.endsWith(".go") && /"log\/slog"/.test(r.read(f) ?? "")),
  );

export const detectErrorTrackingConfigured: Detector = (r) =>
  libraryCheck(
    r,
    /\b(@sentry\/[\w-]+|sentry[-_]sdk|sentry-go|sentry|sentry-ruby|sentry-rails|io\.sentry|bugsnag|rollbar|honeybadger|airbrake|raygun)\b/i,
    (fs) => hasBase(fs, /^(sentry\.properties|sentry\.[\w.]*config\.[cm]?[jt]s|\.sentryclirc)$/),
  );

export const detectPreviewEnvironment: Detector = (r) => {
  const fs = files(r);
  const entry =
    hasBase(fs, /^(docker-compose[\w.-]*\.ya?ml|compose(\.[\w-]+)?\.ya?ml|Tiltfile|skaffold\.ya?ml)$/) ||
    hasPath(fs, /^preview\//) ||
    /^(preview|up|stack):/m.test(text(r, fs.filter((f) => base(f) === "Makefile"))) ||
    /^\s{2}(preview|up|stack):/m.test(text(r, fs.filter((f) => /^Taskfile\.ya?ml$/.test(base(f))))) ||
    /"(preview|up|stack)"\s*:/.test(pkgJson(r, fs));
  if (!entry) return "fail";
  // A single CI workflow must both bring the stack up and run tests against it.
  const hit = ciFiles(fs).some((f) => {
    const t = r.read(f) ?? "";
    return (
      /(docker[- ]compose\s+(-f\s+\S+\s+)?up|tilt\s+ci|skaffold\s+(run|dev)|\b(make|task|npm run|bun run|pnpm|yarn)\s+(preview|up|stack)\b|preview)/i.test(
        t,
      ) && /(e2e|smoke|playwright|cypress|\btest\b)/i.test(t)
    );
  });
  return yn(hit);
};

// ---------- Level 4 ----------

const MAX_LINES = 500;
const MAX_RATIO = 0.05;

function lineCount(content: string): number {
  if (content === "") return 0;
  const n = content.split("\n").length;
  return content.endsWith("\n") ? n - 1 : n;
}

export const detectLargeFilesWithinLimit: Detector = (r) => {
  let total = 0;
  let large = 0;
  for (const f of files(r).filter(isSource)) {
    const content = r.read(f);
    if (content === undefined) continue;
    total += 1;
    if (lineCount(content) > MAX_LINES) large += 1;
  }
  if (total === 0) return "n/a";
  return yn(large / total <= MAX_RATIO);
};

export const detectTracingMetricsInstrumented: Detector = (r) =>
  libraryCheck(
    r,
    /\b(opentelemetry[\w./@-]*|@opentelemetry\/[\w-]+|otel|prom-client|prometheus[\w_-]*|client_golang|dd-trace|ddtrace|datadog|micrometer[\w-]*|statsd|newrelic|new_relic|honeycomb|elastic-apm)\b/i,
    (fs) => hasBase(fs, /^(otel[\w-]*collector[\w-]*|otel-config|prometheus)\.ya?ml$/),
  );

const CANARY =
  /\b(canary|blue[-/ ]?green|argo-?rollouts?|flagger|progressive[-_ ]delivery|traffic[-_ ]split)\b|kind:\s*Rollout\b/i;

// Paths where a staging+production mention actually describes a deploy pipeline.
const DEPLOY_PATH = /(^|\/)(deploy|deployment|deployments|k8s|kubernetes|helm|charts|infra|terraform)\//;
const LOCKFILE = /(^|\/)(pnpm-lock\.ya?ml|yarn\.lock|[\w.-]+\.lock|package-lock\.json)$/;

export const detectStagedCanaryDeploy: Detector = (r) => {
  const fs = files(r);
  const yamlOrTf = fs.filter((f) => CI_FILE.test(f) || (/\.(ya?ml|tf)$/.test(f) && !LOCKFILE.test(f)));
  if (CANARY.test(text(r, yamlOrTf))) return "pass";
  // The staging+production keyword fallback only counts CI and deploy-ish files —
  // OpenAPI specs, compose files and lockfiles mention those words incidentally.
  const deployFiles = fs.filter(
    (f) => CI_FILE.test(f) || (!LOCKFILE.test(f) && (f.endsWith(".tf") || (DEPLOY_PATH.test(f) && /\.ya?ml$/.test(f)))),
  );
  const t = text(r, deployFiles);
  return yn(/\bstaging\b/i.test(t) && /\b(production|prod)\b/i.test(t));
};

// ---------- registry ----------

/** Check id -> detector. Every key must exist in READINESS_CATALOGUE. */
export const DETECTORS: Readonly<Record<string, Detector>> = {
  "readme-present": detectReadmePresent,
  "linter-configured": detectLinterConfigured,
  "type-checker-configured": detectTypeCheckerConfigured,
  "unit-tests-exist": detectUnitTestsExist,
  "agent-instructions-present": detectAgentInstructionsPresent,
  "build-test-documented": detectBuildTestDocumented,
  "dependencies-pinned": detectDependenciesPinned,
  "formatter-configured": detectFormatterConfigured,
  "pre-commit-configured": detectPreCommitConfigured,
  "tool-versions-pinned": detectToolVersionsPinned,
  "codeowners-present": detectCodeownersPresent,
  "ci-runs-lint-typecheck": detectCiRunsLintTypecheck,
  "ci-runs-tests": detectCiRunsTests,
  "smoke-e2e-layer-exists": detectSmokeE2eLayerExists,
  "secret-scanning-ci": detectSecretScanningCi,
  "dependency-automation": detectDependencyAutomation,
  "structured-logging": detectStructuredLogging,
  "error-tracking-configured": detectErrorTrackingConfigured,
  "preview-environment": detectPreviewEnvironment,
  "large-files-within-limit": detectLargeFilesWithinLimit,
  "tracing-metrics-instrumented": detectTracingMetricsInstrumented,
  "staged-canary-deploy": detectStagedCanaryDeploy,
};

/** Run every detector against one reader (memoised so each file is read once). */
export function runDetectors(reader: ReadinessReader): Record<string, CheckResult> {
  const list = reader.listFiles();
  const cache = new Map<string, string | undefined>();
  const memo: ReadinessReader = {
    listFiles: () => list,
    read: (p) => {
      if (!cache.has(p)) cache.set(p, reader.read(p));
      return cache.get(p);
    },
  };
  return Object.fromEntries(Object.entries(DETECTORS).map(([id, d]) => [id, d(memo)]));
}
