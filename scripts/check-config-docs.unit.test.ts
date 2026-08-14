/**
 * scripts/check-config-docs.unit.test.ts
 *
 * Unit tests for the pure string-parsing logic in check-config-docs.ts.
 * No I/O — all inputs are inline strings.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  collectTsFiles,
  extractDocumentedVars,
  extractEnvVarNames,
} from "./check-config-docs.ts";

// ---------------------------------------------------------------------------
// extractEnvVarNames
// ---------------------------------------------------------------------------

describe("extractEnvVarNames", () => {
  test("extracts dot-notation: process.env.VAR_NAME", () => {
    const src = "const x = process.env.ANTHROPIC_API_KEY;";
    expect(extractEnvVarNames(src)).toContain("ANTHROPIC_API_KEY");
  });

  test("extracts bracket string notation: process.env['VAR_NAME']", () => {
    const src = `const x = process.env['NODE_ENV'];`;
    expect(extractEnvVarNames(src)).toContain("NODE_ENV");
  });

  test('extracts bracket double-quote notation: process.env["VAR_NAME"]', () => {
    const src = `const x = process.env["SLACK_BOT_TOKEN"];`;
    expect(extractEnvVarNames(src)).toContain("SLACK_BOT_TOKEN");
  });

  test("extracts optional chaining: process.env?.VAR_NAME", () => {
    const src = "const x = process.env?.PORT;";
    expect(extractEnvVarNames(src)).toContain("PORT");
  });

  test("deduplicates var names appearing multiple times", () => {
    const src = `
      const a = process.env.SLACK_BOT_TOKEN;
      const b = process.env.SLACK_BOT_TOKEN ?? "default";
    `;
    const vars = extractEnvVarNames(src);
    expect(vars.filter((v) => v === "SLACK_BOT_TOKEN")).toHaveLength(1);
  });

  test("extracts multiple distinct vars from one source string", () => {
    const src = `
      const a = process.env.ANTHROPIC_API_KEY;
      const b = process.env.SLACK_BOT_TOKEN;
      const c = process.env['GH_TOKEN'];
    `;
    const vars = extractEnvVarNames(src);
    expect(vars).toContain("ANTHROPIC_API_KEY");
    expect(vars).toContain("SLACK_BOT_TOKEN");
    expect(vars).toContain("GH_TOKEN");
  });

  test("does not extract dynamic bracket access: process.env[key]", () => {
    const src = "const x = process.env[key];";
    const vars = extractEnvVarNames(src);
    // Dynamic access — no literal var name extractable
    expect(vars).not.toContain("key");
  });

  test("returns empty array when no process.env references present", () => {
    const src = `const foo = "bar";\nexport default foo;\n`;
    expect(extractEnvVarNames(src)).toEqual([]);
  });

  test("handles process.env access inside string template", () => {
    const src = "const url = `http://${process.env.HOST}:${process.env.PORT}`;";
    const vars = extractEnvVarNames(src);
    expect(vars).toContain("HOST");
    expect(vars).toContain("PORT");
  });

  test("handles nullish coalescing patterns", () => {
    const src = `const port = process.env.PORT ?? "3000";`;
    const vars = extractEnvVarNames(src);
    expect(vars).toContain("PORT");
  });

  test("does not include lowercase or mixed-case names (only ALL_CAPS accepted by regex)", () => {
    // process.env.foo is valid JS but won't match the uppercase-identifier pattern
    const src = "const x = process.env.foo;";
    const vars = extractEnvVarNames(src);
    // We expect the extractor to only match [A-Z][A-Z0-9_]* identifiers
    expect(vars).not.toContain("foo");
  });
});

// ---------------------------------------------------------------------------
// extractDocumentedVars
// ---------------------------------------------------------------------------

describe("extractDocumentedVars", () => {
  test("extracts backtick-wrapped var name from markdown table: | `VAR_NAME` |", () => {
    const md = `
| Name | Type | Default | Description |
|---|---|---|---|
| \`ANTHROPIC_API_KEY\` | \`string\` | — | Anthropic API key. |
`;
    expect(extractDocumentedVars(md)).toContain("ANTHROPIC_API_KEY");
  });

  test("extracts plain var name from markdown table: | VAR_NAME |", () => {
    const md = `
| Name | Type | Default | Description |
|---|---|---|---|
| SLACK_BOT_TOKEN | string | required | Slack bot token. |
`;
    expect(extractDocumentedVars(md)).toContain("SLACK_BOT_TOKEN");
  });

  test("handles tables with leading/trailing spaces in cells", () => {
    const md = `
| Name | Description |
|---|---|
|  \`PORT\`  | Server port. |
`;
    expect(extractDocumentedVars(md)).toContain("PORT");
  });

  test("extracts vars from multiple tables in one document", () => {
    const md = `
## Section A

| Name | Description |
|---|---|
| \`ANTHROPIC_API_KEY\` | Anthropic key. |

## Section B

| Name | Description |
|---|---|
| \`SLACK_BOT_TOKEN\` | Slack token. |
`;
    const vars = extractDocumentedVars(md);
    expect(vars).toContain("ANTHROPIC_API_KEY");
    expect(vars).toContain("SLACK_BOT_TOKEN");
  });

  test("deduplicates var names appearing in multiple tables", () => {
    const md = `
| Name | Description |
|---|---|
| \`PORT\` | Port A. |

| Name | Description |
|---|---|
| \`PORT\` | Port B. |
`;
    const vars = extractDocumentedVars(md);
    expect(vars.filter((v) => v === "PORT")).toHaveLength(1);
  });

  test("does not extract separator rows (|---|---|)", () => {
    const md = `
| Name | Type |
|---|---|
| \`MY_VAR\` | string |
`;
    const vars = extractDocumentedVars(md);
    expect(vars).not.toContain("---|---");
    expect(vars).not.toContain("---");
    expect(vars).toContain("MY_VAR");
  });

  test("does not extract header row content (Name, Type, Default, Description)", () => {
    const md = `
| Name | Type | Default | Description |
|---|---|---|---|
| \`MY_VAR\` | string | — | Some var. |
`;
    const vars = extractDocumentedVars(md);
    expect(vars).not.toContain("Name");
    expect(vars).not.toContain("Type");
    expect(vars).not.toContain("Default");
    expect(vars).not.toContain("Description");
    expect(vars).toContain("MY_VAR");
  });

  test("returns empty array for markdown with no tables", () => {
    const md = "# Just a heading\n\nSome prose text.\n";
    expect(extractDocumentedVars(md)).toEqual([]);
  });

  test("handles real-world documentation.md format", () => {
    const md = `
### Env vars

| Name | Type | Default | Description |
|---|---|---|---|
| \`SHIPWRIGHT_TASK_STORE\` | \`string\` | — | Selects the task store backend. |
| \`SHIPWRIGHT_GITHUB_OWNER\` | \`string\` | — | GitHub organization. |
| \`GH_CMD\` | \`string\` | \`gh\` | Override the gh CLI executable. |
`;
    const vars = extractDocumentedVars(md);
    expect(vars).toContain("SHIPWRIGHT_TASK_STORE");
    expect(vars).toContain("SHIPWRIGHT_GITHUB_OWNER");
    expect(vars).toContain("GH_CMD");
  });

  test("only returns ALL_CAPS identifiers (skips lowercase table cell values)", () => {
    const md = `
| Name | Type |
|---|---|
| \`MY_VAR\` | string |
| some_other | value |
`;
    const vars = extractDocumentedVars(md);
    expect(vars).toContain("MY_VAR");
    expect(vars).not.toContain("some_other");
  });
});

// ---------------------------------------------------------------------------
// collectTsFiles
// ---------------------------------------------------------------------------

describe("collectTsFiles", () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), "check-config-docs-collect-"));
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  test("collects .ts files at the top level of the directory", () => {
    writeFileSync(join(scratchDir, "a.ts"), "export const a = 1;");
    writeFileSync(join(scratchDir, "b.ts"), "export const b = 2;");

    const out: string[] = [];
    collectTsFiles(scratchDir, out);

    expect(out.sort()).toEqual(
      [join(scratchDir, "a.ts"), join(scratchDir, "b.ts")].sort(),
    );
  });

  test("recurses into nested subdirectories", () => {
    mkdirSync(join(scratchDir, "nested", "deeper"), { recursive: true });
    writeFileSync(join(scratchDir, "top.ts"), "export const t = 1;");
    writeFileSync(
      join(scratchDir, "nested", "mid.ts"),
      "export const m = 1;",
    );
    writeFileSync(
      join(scratchDir, "nested", "deeper", "leaf.ts"),
      "export const l = 1;",
    );

    const out: string[] = [];
    collectTsFiles(scratchDir, out);

    expect(out.sort()).toEqual(
      [
        join(scratchDir, "top.ts"),
        join(scratchDir, "nested", "mid.ts"),
        join(scratchDir, "nested", "deeper", "leaf.ts"),
      ].sort(),
    );
  });

  test("excludes *.test.ts and *.spec.ts files", () => {
    writeFileSync(join(scratchDir, "real.ts"), "export const a = 1;");
    writeFileSync(join(scratchDir, "real.test.ts"), "test stuff");
    writeFileSync(join(scratchDir, "real.spec.ts"), "spec stuff");

    const out: string[] = [];
    collectTsFiles(scratchDir, out);

    expect(out).toEqual([join(scratchDir, "real.ts")]);
  });

  test("excludes non-.ts files (e.g. .md, .json)", () => {
    writeFileSync(join(scratchDir, "readme.md"), "# hi");
    writeFileSync(join(scratchDir, "config.json"), "{}");
    writeFileSync(join(scratchDir, "code.ts"), "export const a = 1;");

    const out: string[] = [];
    collectTsFiles(scratchDir, out);

    expect(out).toEqual([join(scratchDir, "code.ts")]);
  });

  test("skips node_modules, .git, dist, worktrees, and build directories", () => {
    for (const skipped of ["node_modules", ".git", "dist", "worktrees", "build"]) {
      mkdirSync(join(scratchDir, skipped), { recursive: true });
      writeFileSync(
        join(scratchDir, skipped, "should-not-appear.ts"),
        "export const x = 1;",
      );
    }
    writeFileSync(join(scratchDir, "included.ts"), "export const y = 1;");

    const out: string[] = [];
    collectTsFiles(scratchDir, out);

    expect(out).toEqual([join(scratchDir, "included.ts")]);
  });

  test("does not throw and leaves out untouched when the directory does not exist", () => {
    const missingDir = join(scratchDir, "does-not-exist");
    const out: string[] = [];
    expect(() => collectTsFiles(missingDir, out)).not.toThrow();
    expect(out).toEqual([]);
  });

  test("appends to a pre-populated out array rather than replacing it", () => {
    writeFileSync(join(scratchDir, "new.ts"), "export const a = 1;");
    const out: string[] = ["/already/here.ts"];

    collectTsFiles(scratchDir, out);

    expect(out).toContain("/already/here.ts");
    expect(out).toContain(join(scratchDir, "new.ts"));
    expect(out).toHaveLength(2);
  });
});
