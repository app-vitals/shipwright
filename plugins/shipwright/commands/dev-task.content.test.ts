import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { join } from "node:path";

const DEV_TASK_MD_PATH = join(import.meta.dir, "dev-task.md");
const REFERENCES_DIR = join(import.meta.dir, "..", "references", "dev-task");

/** dev-task.md plus the mechanics references it links to (the full dev-task prompt surface). */
function loadDevTaskCorpus(): string {
  const refs = readdirSync(REFERENCES_DIR)
    .filter((f) => f.endsWith(".md") && f !== "dropped-details.md")
    .sort()
    .map((f) => readFileSync(join(REFERENCES_DIR, f), "utf-8"));
  return [readFileSync(DEV_TASK_MD_PATH, "utf-8"), ...refs].join("\n\n");
}

let content: string;

beforeAll(() => {
  content = loadDevTaskCorpus();
});

describe("toolchain-patterns.md — cache schema includes tests object for multi-layer test commands", () => {
  it("defines a tests field in the cache schema", () => {
    const referencesPath = join(
      import.meta.dir,
      "..",
      "references",
      "toolchain-patterns.md",
    );
    const referencesContent = readFileSync(referencesPath, "utf-8");

    const schemaIdx = referencesContent.indexOf('"commands"');
    expect(schemaIdx).toBeGreaterThan(-1);
    const schemaSection = referencesContent.slice(schemaIdx, schemaIdx + 500);
    expect(schemaSection).toContain('"tests"');
  });

  it("documents multi-layer test detection", () => {
    const referencesPath = join(
      import.meta.dir,
      "..",
      "references",
      "toolchain-patterns.md",
    );
    const referencesContent = readFileSync(referencesPath, "utf-8");
    expect(referencesContent).toContain("### Multi-Layer Test Detection");
    expect(referencesContent).toMatch(/keys are free-form/i);
  });
});

describe("toolchain-patterns.md — cache schema includes lintScoped for diff-scoped lint detection (LSC-1.1)", () => {
  it("defines a lintScoped field in the cache schema", () => {
    const referencesPath = join(
      import.meta.dir,
      "..",
      "references",
      "toolchain-patterns.md",
    );
    const referencesContent = readFileSync(referencesPath, "utf-8");

    const schemaIdx = referencesContent.indexOf('"commands"');
    expect(schemaIdx).toBeGreaterThan(-1);
    const schemaSection = referencesContent.slice(schemaIdx, schemaIdx + 500);
    expect(schemaSection).toContain('"lintScoped"');
  });

  it("documents lintScoped as omitted (never null) when no scoped command is available", () => {
    const referencesPath = join(
      import.meta.dir,
      "..",
      "references",
      "toolchain-patterns.md",
    );
    const referencesContent = readFileSync(referencesPath, "utf-8");

    const fieldIdx = referencesContent.indexOf("**Scoped fields (`lintScoped`");
    expect(fieldIdx).toBeGreaterThan(-1);
    const fieldSection = referencesContent.slice(fieldIdx, fieldIdx + 700);
    expect(fieldSection).toMatch(/omit/i);
    expect(fieldSection).toMatch(/never.{0,20}null/i);
  });

  it("documents the Turborepo scoped-lint detection rule", () => {
    const referencesPath = join(
      import.meta.dir,
      "..",
      "references",
      "toolchain-patterns.md",
    );
    const referencesContent = readFileSync(referencesPath, "utf-8");

    expect(referencesContent).toContain("turbo.json");
    expect(referencesContent).toContain("turbo lint --filter=");
  });

  it("documents the Nx scoped-lint detection rule", () => {
    const referencesPath = join(
      import.meta.dir,
      "..",
      "references",
      "toolchain-patterns.md",
    );
    const referencesContent = readFileSync(referencesPath, "utf-8");

    expect(referencesContent).toContain("nx.json");
    expect(referencesContent).toContain("nx affected --target=lint --base=");
  });

  it("documents the pnpm workspaces scoped-lint detection rule", () => {
    const referencesPath = join(
      import.meta.dir,
      "..",
      "references",
      "toolchain-patterns.md",
    );
    const referencesContent = readFileSync(referencesPath, "utf-8");

    expect(referencesContent).toContain("pnpm-workspace.yaml");
    expect(referencesContent).toMatch(
      /pnpm --filter "\.\.\.\[\{base\}\]" lint/,
    );
  });

  it("documents the generic eslint changed-files fallback for no monorepo tool detected", () => {
    const referencesPath = join(
      import.meta.dir,
      "..",
      "references",
      "toolchain-patterns.md",
    );
    const referencesContent = readFileSync(referencesPath, "utf-8");

    const sectionIdx = referencesContent.indexOf("### Scoped Check Detection");
    expect(sectionIdx).toBeGreaterThan(-1);
    const section = referencesContent.slice(sectionIdx, sectionIdx + 2000);
    expect(section).toMatch(/no monorepo tool/i);
    expect(section).toMatch(/eslint/i);
    expect(section).toMatch(/changed/i);
  });
});

describe("toolchain-patterns.md — generalized typecheckScoped/testScoped detection across ecosystems (LVB-3.1)", () => {
  it("defines typecheckScoped and testScoped fields in the cache schema", () => {
    const referencesPath = join(
      import.meta.dir,
      "..",
      "references",
      "toolchain-patterns.md",
    );
    const referencesContent = readFileSync(referencesPath, "utf-8");

    const schemaIdx = referencesContent.indexOf('"commands"');
    expect(schemaIdx).toBeGreaterThan(-1);
    const schemaSection = referencesContent.slice(schemaIdx, schemaIdx + 500);
    expect(schemaSection).toContain('"typecheckScoped"');
    expect(schemaSection).toContain('"testScoped"');
  });

  it("does not declare a scoped field without a corresponding per-ecosystem detection rule", () => {
    const referencesPath = join(
      import.meta.dir,
      "..",
      "references",
      "toolchain-patterns.md",
    );
    const referencesContent = readFileSync(referencesPath, "utf-8");

    // Every `*Scoped` field named anywhere in the doc must be more than a schema
    // placeholder: it needs at least one detection rule / ecosystem mention beyond
    // the schema block and the shared "Scoped fields" definition bullet. Guards the
    // LVB-3.1 review finding — `installScoped` was declared with no rule defining it.
    const scopedFields = new Set(
      [...referencesContent.matchAll(/`?"?(\w+Scoped)"?`?/g)].map(
        (m) => m[1] as string,
      ),
    );
    expect(scopedFields.size).toBeGreaterThan(0);

    for (const field of scopedFields) {
      const occurrences = referencesContent.split(field).length - 1;
      expect(
        occurrences,
        `${field} is named ${occurrences}x — a scoped field needs a per-ecosystem detection rule, not just a schema entry`,
      ).toBeGreaterThan(2);
    }
  });

  it("extends the Node.js scoped-check priority table to testScoped and typecheckScoped, not just lint", () => {
    const referencesPath = join(
      import.meta.dir,
      "..",
      "references",
      "toolchain-patterns.md",
    );
    const referencesContent = readFileSync(referencesPath, "utf-8");

    const sectionIdx = referencesContent.indexOf("### Scoped Check Detection");
    expect(sectionIdx).toBeGreaterThan(-1);
    const section = referencesContent.slice(sectionIdx, sectionIdx + 2500);
    expect(section).toContain("turbo test --filter=");
    expect(section).toContain("turbo typecheck --filter=");
    expect(section).toContain("nx affected --target=test --base=");
    expect(section).toContain("nx affected --target=typecheck --base=");
    expect(section).toMatch(/pnpm --filter "\.\.\.\[\{base\}\]" test/);
    expect(section).toMatch(/pnpm --filter "\.\.\.\[\{base\}\]" typecheck/);
  });

  it("documents the Java Maven reactor -pl/-am scoped test command", () => {
    const referencesPath = join(
      import.meta.dir,
      "..",
      "references",
      "toolchain-patterns.md",
    );
    const referencesContent = readFileSync(referencesPath, "utf-8");

    expect(referencesContent).toContain("mvn test -pl {module} -am");
  });

  it("documents the Java Gradle module-targeting scoped test command", () => {
    const referencesPath = join(
      import.meta.dir,
      "..",
      "references",
      "toolchain-patterns.md",
    );
    const referencesContent = readFileSync(referencesPath, "utf-8");

    expect(referencesContent).toContain("./gradlew :{module}:test");
  });

  it("documents Go/Rust scoped test detection with a caveat that affected-tooling is weaker there", () => {
    const referencesPath = join(
      import.meta.dir,
      "..",
      "references",
      "toolchain-patterns.md",
    );
    const referencesContent = readFileSync(referencesPath, "utf-8");

    const rustIdx = referencesContent.indexOf("## Rust");
    const goIdx = referencesContent.indexOf("## Go");
    expect(rustIdx).toBeGreaterThan(-1);
    expect(goIdx).toBeGreaterThan(rustIdx);

    const rustSection = referencesContent.slice(rustIdx, goIdx);
    expect(rustSection).toContain("cargo test -p {crate}");
    expect(rustSection).toMatch(/cheap/i);

    const javaIdx = referencesContent.indexOf("## Java");
    const goSection = referencesContent.slice(
      goIdx,
      javaIdx > -1 ? javaIdx : goIdx + 3000,
    );
    expect(goSection).toContain("go test ./{changed-package}/...");
    expect(goSection).toMatch(/cheap/i);
  });

  it("documents Python and Ruby as best-effort/full-suite by default, not attempting scoped detection", () => {
    const referencesPath = join(
      import.meta.dir,
      "..",
      "references",
      "toolchain-patterns.md",
    );
    const referencesContent = readFileSync(referencesPath, "utf-8");

    const pythonIdx = referencesContent.indexOf("## Python");
    const rubyIdx = referencesContent.indexOf("## Ruby");
    expect(pythonIdx).toBeGreaterThan(-1);
    expect(rubyIdx).toBeGreaterThan(pythonIdx);

    const pythonSection = referencesContent.slice(pythonIdx, rubyIdx);
    expect(pythonSection).toMatch(/not attempted/i);
    expect(pythonSection).toMatch(/best-effort\/full-suite/i);

    const genericIdx = referencesContent.indexOf("## Generic / Makefile");
    const rubySection = referencesContent.slice(
      rubyIdx,
      genericIdx > -1 ? genericIdx : rubyIdx + 1000,
    );
    expect(rubySection).toMatch(/not attempted/i);
  });

  it("states the 'never run a target the diff doesn't touch' rule generically, not tied to Node/monorepo tooling", () => {
    const referencesPath = join(
      import.meta.dir,
      "..",
      "references",
      "toolchain-patterns.md",
    );
    const referencesContent = readFileSync(referencesPath, "utf-8");

    const sectionIdx = referencesContent.indexOf(
      "## Never Run a Target the Diff Doesn't Touch",
    );
    expect(sectionIdx).toBeGreaterThan(-1);
    const section = referencesContent.slice(sectionIdx, sectionIdx + 1500);
    expect(section).toMatch(
      /general rule, not specific to Node\/monorepo tooling/i,
    );
    expect(section).toMatch(/mobile\/native export step/i);
  });
});

describe("toolchain-patterns.md — fingerprint path list covers task-runner/version-manager config (CPF-review-2242)", () => {
  it("includes Taskfile.yml, justfile/Justfile, and mise.toml/.mise.toml alongside the other fingerprinted paths", () => {
    const referencesPath = join(
      import.meta.dir,
      "..",
      "references",
      "toolchain-patterns.md",
    );
    const referencesContent = readFileSync(referencesPath, "utf-8");

    const fingerprintIdx = referencesContent.indexOf(
      "git -C {repo-dir} log -1 --format=%H --",
    );
    expect(fingerprintIdx).toBeGreaterThan(-1);
    const fingerprintLine = referencesContent.slice(
      fingerprintIdx,
      referencesContent.indexOf("\n", fingerprintIdx),
    );

    expect(fingerprintLine).toContain("Taskfile.yml");
    expect(fingerprintLine).toContain("justfile");
    expect(fingerprintLine).toContain("Justfile");
    expect(fingerprintLine).toContain("mise.toml");
    expect(fingerprintLine).toContain(".mise.toml");
  });
});

describe("toolchain-patterns.md — docsSource pointer + scoped fingerprint (LVB-4.1)", () => {
  const referencesPath = join(
    import.meta.dir,
    "..",
    "references",
    "toolchain-patterns.md",
  );
  const referencesContent = readFileSync(referencesPath, "utf-8");

  it("Docs-First Discovery records a {path, heading} pointer to the source doc", () => {
    const sectionIdx = referencesContent.indexOf("## Docs-First Discovery");
    const cachingIdx = referencesContent.indexOf("## Caching Across Runs");
    expect(sectionIdx).toBeGreaterThan(-1);
    expect(cachingIdx).toBeGreaterThan(sectionIdx);
    const section = referencesContent.slice(sectionIdx, cachingIdx);
    expect(section).toMatch(/docsSource/);
    expect(section).toMatch(/\{\s*path\s*,\s*heading\s*\}/);
  });

  it("defines a docsSource field in the cache schema", () => {
    const cachingIdx = referencesContent.indexOf("## Caching Across Runs");
    const schemaIdx = referencesContent.indexOf('"commands"', cachingIdx);
    expect(schemaIdx).toBeGreaterThan(-1);
    const schemaSection = referencesContent.slice(cachingIdx, schemaIdx);
    expect(schemaSection).toContain('"docsSource"');
  });

  it("documents docsSource as omitted (never null) when detection falls through to config-file scanning", () => {
    const fieldIdx = referencesContent.indexOf("**`docsSource`**");
    expect(fieldIdx).toBeGreaterThan(-1);
    const fieldSection = referencesContent.slice(fieldIdx, fieldIdx + 500);
    expect(fieldSection).toMatch(/omit/i);
    expect(fieldSection).toMatch(/never.{0,20}null/i);
  });

  it("scopes the fingerprint so a routine lockfile-only dependency bump no longer invalidates the cache", () => {
    const fingerprintIdx = referencesContent.indexOf("**Fingerprint**");
    expect(fingerprintIdx).toBeGreaterThan(-1);
    const nextSectionIdx = referencesContent.indexOf("## Detection Order");
    expect(nextSectionIdx).toBeGreaterThan(fingerprintIdx);
    const section = referencesContent.slice(fingerprintIdx, nextSectionIdx);
    expect(section).toMatch(/lockfile-only/i);
    // The actual recipes (the bash code blocks) must not hash any lockfile —
    // mentioning lockfiles in surrounding prose (as explicitly excluded) is fine.
    const codeBlocks = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map(
      (m) => m[1],
    );
    expect(codeBlocks.length).toBeGreaterThan(0);
    for (const block of codeBlocks) {
      expect(block).not.toMatch(/package-lock\.json/);
      expect(block).not.toMatch(/bun\.lock\b/);
      expect(block).not.toMatch(/bun\.lockb/);
      expect(block).not.toMatch(/yarn\.lock/);
      expect(block).not.toMatch(/pnpm-lock\.yaml/);
    }
  });

  it("scopes the docsSource-populated fingerprint to the pointed-to heading plus package.json's scripts block", () => {
    const fingerprintIdx = referencesContent.indexOf("**Fingerprint**");
    const nextSectionIdx = referencesContent.indexOf("## Detection Order");
    const section = referencesContent.slice(fingerprintIdx, nextSectionIdx);
    expect(section).toMatch(/docsSource[\s\S]{0,400}heading/i);
    expect(section).toMatch(/scripts/);
  });

  it("ends the heading extraction at the next same-or-shallower heading, not at any nested subheading", () => {
    const awkIdx = referencesContent.indexOf("heading_content=$(awk");
    expect(awkIdx).toBeGreaterThan(-1);
    const awkBlock = referencesContent.slice(
      awkIdx,
      referencesContent.indexOf("```", awkIdx),
    );

    // Must derive the target heading's level from docsSource.heading...
    expect(awkBlock).toMatch(/match\(h, \/\^#\+\/\)/);
    expect(awkBlock).toMatch(/level\s*=\s*RLENGTH/);
    // ...and only exit on a subsequent heading at that level or shallower.
    expect(awkBlock).toMatch(/RLENGTH\s*<=\s*level.*exit/);
    // A bare unconditional exit on any heading would truncate the section at the
    // first nested subheading, silently producing a stale-command cache hit.
    expect(awkBlock).not.toMatch(/\/\^#\{1,6\} \/\s*\{\s*exit\s*\}/);
  });

  it("explains why truncating at a nested subheading would be a false cache hit", () => {
    const fingerprintIdx = referencesContent.indexOf("**Fingerprint**");
    const nextSectionIdx = referencesContent.indexOf("## Detection Order");
    const section = referencesContent.slice(fingerprintIdx, nextSectionIdx);
    expect(section).toMatch(/same or shallower level/i);
    expect(section).toMatch(/nested subheading/i);
    expect(section).toMatch(/false cache \*?hit/i);
  });

  it("excludes the no-pointer fallback target docs/toolchain.md from the config-file fingerprint pathspec for the same reason (LVB-4.2)", () => {
    const fingerprintIdx = referencesContent.indexOf("**Fingerprint**");
    const nextSectionIdx = referencesContent.indexOf("## Detection Order");
    const section = referencesContent.slice(fingerprintIdx, nextSectionIdx);
    const gitLogIdx = section.indexOf("git -C {repo-dir} log -1");
    expect(gitLogIdx).toBeGreaterThan(-1);
    const gitLogLine = section.slice(
      gitLogIdx,
      section.indexOf("\n", gitLogIdx),
    );
    // docs/toolchain.md lives under the `docs` pathspec entry, so without an
    // explicit exclude every learned-facts commit would move this recipe's %H.
    expect(gitLogLine).toMatch(/:\(exclude\)docs\/toolchain\.md/);
  });

  it("explains the no-pointer pathspec exclusion as a self-invalidation guard, the same exclusion principle already applied to lockfiles", () => {
    const fingerprintIdx = referencesContent.indexOf("**Fingerprint**");
    const nextSectionIdx = referencesContent.indexOf("## Detection Order");
    const section = referencesContent.slice(fingerprintIdx, nextSectionIdx);
    expect(section).toMatch(/self-invalidat/i);
    expect(section).toMatch(/no-pointer half/i);
  });

  it("no longer strips a 'Shipwright Learned Facts' marker subsection in the docsSource-populated recipe — the write-back mechanism it guarded against is gone", () => {
    const awkIdx = referencesContent.indexOf("heading_content=$(awk");
    expect(awkIdx).toBeGreaterThan(-1);
    const awkBlock = referencesContent.slice(
      awkIdx,
      referencesContent.indexOf("```", awkIdx),
    );
    expect(awkBlock).not.toContain("| awk");
    expect(awkBlock).not.toMatch(/marker_level/);
    expect(awkBlock).not.toContain("Shipwright Learned Facts");
  });
});

describe("toolchain-patterns.md — relocation-on-staleness for broken pointer (LVB-4.3)", () => {
  const referencesPath = join(import.meta.dir, "..", "references", "toolchain-patterns.md");
  const referencesContent = readFileSync(referencesPath, "utf-8");

  it("defines a Relocation on Broken Pointer subsection under Caching Across Runs", () => {
    const cachingIdx = referencesContent.indexOf("## Caching Across Runs");
    const detectionOrderIdx = referencesContent.indexOf("## Detection Order");
    expect(cachingIdx).toBeGreaterThan(-1);
    expect(detectionOrderIdx).toBeGreaterThan(cachingIdx);

    const relocationIdx = referencesContent.indexOf("Relocation on Broken Pointer");
    expect(relocationIdx).toBeGreaterThan(cachingIdx);
    expect(relocationIdx).toBeLessThan(detectionOrderIdx);
  });

  it("defines a broken pointer as path-no-longer-exists OR heading-no-longer-found, citing doc-refresh-recipe.md's verification checks", () => {
    const relocationIdx = referencesContent.indexOf("Relocation on Broken Pointer");
    expect(relocationIdx).toBeGreaterThan(-1);
    const detectionOrderIdx = referencesContent.indexOf("## Detection Order");
    const section = referencesContent.slice(relocationIdx, detectionOrderIdx);

    expect(section).toMatch(/doc-refresh-recipe\.md/);
    expect(section).toMatch(/docsSource\.path/);
    expect(section).toMatch(/docsSource\.heading/);
    expect(section).toMatch(/no longer exists|gone|missing/i);
  });

  it("attempts a relocation search BEFORE falling back to config-file fallback / doc recreation", () => {
    const relocationIdx = referencesContent.indexOf("Relocation on Broken Pointer");
    expect(relocationIdx).toBeGreaterThan(-1);
    const detectionOrderIdx = referencesContent.indexOf("## Detection Order");
    const section = referencesContent.slice(relocationIdx, detectionOrderIdx);

    expect(section).toMatch(/relocat/i);
    expect(section).toMatch(/before/i);
    expect(section).toMatch(/fallback/i);

    // Ordering assertion, not just presence: "relocat*" language must appear
    // before the fallback-only-if-relocation-fails language in document order.
    const firstRelocationMention = section.search(/relocat/i);
    const fallbackOnlyIfFailed = section.search(/relocation (also )?fails/i);
    expect(fallbackOnlyIfFailed).toBeGreaterThan(-1);
    expect(firstRelocationMention).toBeLessThan(fallbackOnlyIfFailed);
  });

  it("relocate-success: a successful relocation updates the stored docsSource pointer to the new path/heading", () => {
    const relocationIdx = referencesContent.indexOf("Relocation on Broken Pointer");
    expect(relocationIdx).toBeGreaterThan(-1);
    const detectionOrderIdx = referencesContent.indexOf("## Detection Order");
    const section = referencesContent.slice(relocationIdx, detectionOrderIdx);

    expect(section).toMatch(/succeed/i);
    expect(section).toMatch(/update(s|d)?\s+(the\s+)?stored\s+`?docsSource/i);
    expect(section).not.toMatch(/relocation succeeds[\s\S]{0,300}config-file fallback/i);
  });

  it("relocate-fails-fallback-to-default: falls back to config-file detection / doc recreation only when relocation also fails", () => {
    const relocationIdx = referencesContent.indexOf("Relocation on Broken Pointer");
    expect(relocationIdx).toBeGreaterThan(-1);
    const detectionOrderIdx = referencesContent.indexOf("## Detection Order");
    const section = referencesContent.slice(relocationIdx, detectionOrderIdx);

    expect(section).toMatch(/relocation (also )?fails/i);
    expect(section).toMatch(/config-file fallback/i);
    expect(section).toMatch(/\(re\)create|recreate|derive the default/i);
  });

  it("step 2's cache-miss routing defers to the relocation subsection for a broken docsSource pointer", () => {
    const cachingIdx = referencesContent.indexOf("## Caching Across Runs");
    const relocationIdx = referencesContent.indexOf("### Relocation on Broken Pointer");
    expect(cachingIdx).toBeGreaterThan(-1);
    expect(relocationIdx).toBeGreaterThan(cachingIdx);

    // Step 2 is the numbered cache-miss branch between the cache-hit step and the
    // relocation subsection. It must carve out the broken-pointer case rather than
    // routing every fingerprint mismatch straight to the config-file fallback.
    const stepTwoIdx = referencesContent.indexOf("2. Otherwise —", cachingIdx);
    expect(stepTwoIdx).toBeGreaterThan(-1);
    expect(stepTwoIdx).toBeLessThan(relocationIdx);
    const stepTwo = referencesContent.slice(stepTwoIdx, relocationIdx);

    expect(stepTwo).toMatch(/Relocation on Broken Pointer/);
    expect(stepTwo).toMatch(/docsSource/);
    expect(stepTwo).toMatch(/govern|override|refine|unless|exception/i);
  });

  it("the relocation subsection states it refines step 2 rather than standing alongside it", () => {
    const relocationIdx = referencesContent.indexOf("### Relocation on Broken Pointer");
    expect(relocationIdx).toBeGreaterThan(-1);
    const detectionOrderIdx = referencesContent.indexOf("## Detection Order");
    const section = referencesContent.slice(relocationIdx, detectionOrderIdx);

    expect(section).toMatch(/step 2/i);
    expect(section).toMatch(/refine|override|govern/i);
  });

  it("delegates to doc-refresh-recipe.md's verification-table pattern rather than re-embedding the table", () => {
    const relocationIdx = referencesContent.indexOf("Relocation on Broken Pointer");
    expect(relocationIdx).toBeGreaterThan(-1);
    const detectionOrderIdx = referencesContent.indexOf("## Detection Order");
    const section = referencesContent.slice(relocationIdx, detectionOrderIdx);

    expect(section).toMatch(/doc-refresh-recipe\.md/);
    // Must not re-embed the verification table itself (its distinctive header row).
    expect(section).not.toMatch(/\|\s*Check\s*\|\s*Method\s*\|\s*Stale if\s*\|/i);
  });
});

const REQUIRED_STEPS_PATH = join(
  import.meta.dir,
  "..",
  "references",
  "required-steps",
  "dev-task.json",
);
const command = readFileSync(DEV_TASK_MD_PATH, "utf-8");
const steps = JSON.parse(readFileSync(REQUIRED_STEPS_PATH, "utf-8")).steps as {
  stepNumber: string;
  title: string;
  mandatory: boolean;
}[];

describe("dev-task.md — required steps", () => {
  for (const step of steps) {
    it(`names step ${step.stepNumber} (${step.title})`, () => {
      expect(command).toContain(`## Step ${step.stepNumber}: ${step.title}`);
    });
  }

  it("gives every mandatory step a Proof line", () => {
    for (const step of steps.filter((s) => s.mandatory)) {
      const start = command.indexOf(`## Step ${step.stepNumber}:`);
      const next = command.indexOf("\n## ", start + 1);
      expect(command.slice(start, next)).toContain("**Proof:**");
    }
  });

  it("keeps the no-size-exemption rule", () => {
    expect(command).toMatch(/no size exemption/i);
  });
});

describe("dev-task.md — frontmatter and argument contract", () => {
  it("declares a required task-id argument and a plain dev-task description", () => {
    const frontmatter = command.slice(0, command.indexOf("---", 3));
    expect(frontmatter).toContain('argument-hint: "<task-id>"');
    expect(frontmatter).not.toMatch(/lean|variant/i);
    expect(command).toContain("# Dev Task\n");
  });

  it("responds [silent] with no task-store queries when task-id is empty", () => {
    expect(command).toMatch(/task-id.{0,40}required/is);
    expect(command).toContain("`[silent]`");
  });

  it("does not scan the ready queue or resume interrupted tasks", () => {
    expect(corpusOnly()).not.toContain("tasks?ready=true");
    expect(corpusOnly()).not.toContain("Resuming interrupted task");
  });

  it("does not mention a lean variant anywhere", () => {
    expect(corpusOnly()).not.toMatch(/dev-task-lean/);
  });
});

function corpusOnly(): string {
  return loadDevTaskCorpus();
}

describe("dev-task.md — links", () => {
  const links = [...command.matchAll(/\]\((\.\.\/[^)]+)\)/g)].map((m) => m[1]);

  it("links at least one reference file", () => {
    expect(links.length).toBeGreaterThan(0);
  });

  it("every linked reference file exists", () => {
    for (const link of links) {
      expect(existsSync(resolve(dirname(DEV_TASK_MD_PATH), link))).toBe(true);
    }
  });

  it("links every reference file in references/dev-task/", () => {
    for (const f of readdirSync(REFERENCES_DIR).filter((n) => n.endsWith(".md"))) {
      expect(command).toContain(`references/dev-task/${f}`);
    }
  });

  it("every relative link inside the moved reference files resolves", () => {
    for (const f of readdirSync(REFERENCES_DIR).filter((n) => n.endsWith(".md"))) {
      const text = readFileSync(join(REFERENCES_DIR, f), "utf-8");
      for (const m of text.matchAll(/\]\(((?!https?:|#)[^)\s]+)\)/g)) {
        expect(existsSync(resolve(REFERENCES_DIR, m[1].split("#")[0]))).toBe(true);
      }
    }
  });
});

describe("dev-task references — preserved behavior", () => {
  const corpus = loadDevTaskCorpus();

  it("claims atomically via POST /tasks/{id}/claim and stops silently on 409/404", () => {
    expect(command).toContain("POST /tasks/{id}/claim");
    expect(command).toMatch(/409\/404 → `\[silent\]`/);
  });

  it("claim sends claimedBy with the SHIPWRIGHT_AGENT_ID:-local fallback (CRQ-6.2)", () => {
    // Previously pinned a no-body claim; non-agent tokens get 400 `claimedBy is required` without it.
    expect(command).toContain("${SHIPWRIGHT_AGENT_ID:-local}");
    expect(corpus).toContain('jq -n --arg claimedBy "$CLAIMED_BY" \'{claimedBy: $claimedBy}\'');
    expect(corpus).not.toContain("No body (the agent token pins `claimedBy`)");
  });

  it("defers with namespaced skip-reason markers", () => {
    expect(corpus).toContain("[skip-reason:dev-task:deferred:dependency-unsatisfied:{dep-id}]");
    expect(corpus).toContain("[skip-reason:dev-task:deferred:same-branch-sibling-busy:{branch}]");
  });

  it("blocks misrouted PRD-shaped tasks", () => {
    expect(corpus).toContain("misrouted_needs_plan_session_not_dev_task");
  });

  it("runs the branch/PR reality check against live git state", () => {
    expect(corpus).toContain("ls-remote");
  });

  it("dispatches subagents in the foreground and honours phase methodology", () => {
    expect(command).toContain("run_in_background: false");
    expect(corpus).toContain("phaseMethodology");
  });

  it("forbids scheduled wakeups and explains the stale-claim TTL", () => {
    expect(corpus).toContain("No scheduled wakeups");
    expect(corpus).toContain("StaleClaimReaper");
  });

  it("records verification outcomes with all four statuses", () => {
    expect(corpus).toContain("/verification-checks");
    for (const s of ["ran_passed", "ran_failed", "skipped", "timed_out"]) {
      expect(corpus).toContain(s);
    }
  });

  it("supports learned skips and scoped lint", () => {
    expect(corpus).toContain("learned_skip");
    expect(corpus).toContain("lintScoped");
  });

  it("derives a conventional PR title", () => {
    expect(corpus).toMatch(/conventional/i);
  });

  it("blocks with ci_max_retries_exhausted when the CI fix loop is exhausted", () => {
    expect(command).toContain("ci_max_retries_exhausted");
  });

  it("checks the PATCH status code at hand-off and aborts on non-2xx", () => {
    expect(corpus).toContain("PATCH_CODE");
    expect(corpus).toMatch(/Non-2xx → print/);
  });
});

describe("dev-task references — missing-branch block reason (DBH-1.1)", () => {
  it("records blockedReason missing_branch and still prints the branch PATCH hint", () => {
    const lifecycle = readFileSync(
      join(REFERENCES_DIR, "task-lifecycle.md"),
      "utf-8",
    );
    const section = lifecycle.split("## Missing branch")[1]?.split("\n## ")[0];
    expect(section).toContain('"blockedReason":"missing_branch"');
    expect(section).toContain("`branch`");
  });
});
