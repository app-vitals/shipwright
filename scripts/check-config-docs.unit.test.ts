/**
 * scripts/check-config-docs.unit.test.ts
 *
 * Unit tests for the pure string-parsing logic in check-config-docs.ts.
 * No I/O — all inputs are inline strings.
 */

import { describe, expect, test } from "bun:test";
import {
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
