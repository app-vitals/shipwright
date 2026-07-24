/**
 * docs/agent-types.content.test.ts
 *
 * Content-layer tests for docs/agent-types.md — the public authoring guide
 * for AgentType manifests (ATS-5.1). No real I/O boundary beyond reading the
 * doc + walking the live Zod schema; this is a content-assertion test, not
 * integration.
 *
 * Acceptance criteria covered:
 *   1. Every field exported by AgentTypeManifestSchema appears in the doc's
 *      field reference (schema field-key list cross-referenced against the
 *      doc's field-reference tables).
 *   2. The blank template in the doc validates against the schema.
 *   3. FLOOR_TOOLS, no-secrets, and crons-ship-disabled rules are each
 *      stated in the Rules section.
 *   4. Required sections + field coverage + template validity are asserted
 *      here.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentTypeManifestSchema,
  parseAgentTypeManifest,
} from "../admin/src/agent-type-registry.ts";

const DOC_PATH = join(import.meta.dir, "agent-types.md");
const content = readFileSync(DOC_PATH, "utf-8");

// ─── Schema field-key walker ────────────────────────────────────────────────

/**
 * Minimal structural shape shared by every Zod schema instance's internal
 * `_def` — enough to walk ZodObject/ZodOptional/ZodDefault/ZodArray/
 * ZodEffects wrappers without importing the `zod` package directly. Avoiding
 * a direct `zod` import matters here: this test lives under docs/, which is
 * not a Bun workspace with `zod` as a direct dependency, so Bun's
 * node_modules resolution (which walks up from the *importing file's*
 * directory) can't find it — mirrors why agent-types/coding/manifest.content.test.ts
 * only imports `parseAgentTypeManifest`, never `zod` itself.
 */
interface ZodLike {
  _def: {
    typeName: string;
    innerType?: ZodLike;
    type?: ZodLike;
    schema?: ZodLike;
  };
  shape?: Record<string, ZodLike>;
}

function unwrap(schema: ZodLike): ZodLike {
  let current = schema;
  for (;;) {
    const { typeName } = current._def;
    if (
      (typeName === "ZodOptional" || typeName === "ZodDefault") &&
      current._def.innerType
    ) {
      current = current._def.innerType;
    } else if (typeName === "ZodArray" && current._def.type) {
      current = current._def.type;
    } else if (typeName === "ZodEffects" && current._def.schema) {
      current = current._def.schema;
    } else {
      return current;
    }
  }
}

function collectFieldKeys(
  schema: ZodLike,
  seen = new Set<string>(),
): Set<string> {
  const resolved = unwrap(schema);
  if (resolved._def.typeName === "ZodObject" && resolved.shape) {
    for (const [key, value] of Object.entries(resolved.shape)) {
      seen.add(key);
      collectFieldKeys(value, seen);
    }
  }
  return seen;
}

const schemaFieldKeys = collectFieldKeys(
  AgentTypeManifestSchema as unknown as ZodLike,
);

// ─── Required sections ──────────────────────────────────────────────────────

describe("docs/agent-types.md — required sections", () => {
  const requiredHeadings = [
    "# Agent Type",
    "## Concept",
    "## Field reference",
    "## Blank template",
    "## Worked examples",
    "## Rules",
  ];

  for (const heading of requiredHeadings) {
    it(`contains a "${heading}" heading`, () => {
      expect(content).toContain(heading);
    });
  }

  it("links to the generated JSON Schema artifact", () => {
    expect(content).toContain("docs/schemas/agent-type.schema.json");
  });
});

// ─── Field reference coverage (acceptance criterion 1) ─────────────────────

describe("docs/agent-types.md — field reference coverage", () => {
  it("schema field-key walker finds fields at every nesting level (sanity check on the fixture itself)", () => {
    // Guards against the walker silently returning an empty/tiny set if the
    // schema shape ever changes in a way that breaks unwrap().
    expect(schemaFieldKeys.size).toBeGreaterThan(20);
    expect(schemaFieldKeys.has("apiVersion")).toBe(true);
    expect(schemaFieldKeys.has("metadata")).toBe(true);
    expect(schemaFieldKeys.has("skills")).toBe(true); // nested under metadata
    expect(schemaFieldKeys.has("cpu")).toBe(true); // nested under resources.requests/limits
  });

  const fieldReferenceStart = content.indexOf("## Field reference");
  const blankTemplateStart = content.indexOf("## Blank template");
  const fieldReferenceSection = content.slice(
    fieldReferenceStart,
    blankTemplateStart,
  );

  for (const key of Array.from(schemaFieldKeys).sort()) {
    it(`field reference documents \`${key}\``, () => {
      expect(fieldReferenceSection).toContain(`\`${key}\``);
    });
  }
});

// ─── Blank template validity (acceptance criterion 2) ───────────────────────

function extractFencedCodeBlocks(markdown: string, lang: string): string[] {
  const pattern = new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``, "g");
  const blocks: string[] = [];
  for (const match of markdown.matchAll(pattern)) {
    blocks.push(match[1]);
  }
  return blocks;
}

describe("docs/agent-types.md — blank template validity", () => {
  const blankTemplateStart = content.indexOf("## Blank template");
  const workedExamplesStart = content.indexOf("## Worked examples");
  it("has a Blank template section before Worked examples", () => {
    expect(blankTemplateStart).toBeGreaterThan(-1);
    expect(workedExamplesStart).toBeGreaterThan(blankTemplateStart);
  });

  const blankTemplateSection = content.slice(
    blankTemplateStart,
    workedExamplesStart,
  );
  const yamlBlocks = extractFencedCodeBlocks(blankTemplateSection, "yaml");

  it("has exactly one fenced yaml code block in the Blank template section", () => {
    expect(yamlBlocks).toHaveLength(1);
  });

  it("the blank template parses and validates against AgentTypeManifestSchema", () => {
    const template = yamlBlocks[0];
    expect(template).toBeDefined();
    if (!template) return;
    expect(() => parseAgentTypeManifest(template)).not.toThrow();
  });

  it("the blank template has apiVersion/kind shipwright.dev/v1alpha1/AgentType", () => {
    const template = yamlBlocks[0];
    expect(template).toBeDefined();
    if (!template) return;
    const manifest = parseAgentTypeManifest(template);
    expect(manifest.apiVersion).toBe("shipwright.dev/v1alpha1");
    expect(manifest.kind).toBe("AgentType");
  });
});

// ─── Worked examples per configurable surface ──────────────────────────────

describe("docs/agent-types.md — worked examples per configurable surface", () => {
  const workedExamplesStart = content.indexOf("## Worked examples");
  const rulesStart = content.indexOf("## Rules");
  const workedExamplesSection = content.slice(workedExamplesStart, rulesStart);

  const surfaces = ["crons", "env", "plugins", "members", "tools", "repos"];
  for (const surface of surfaces) {
    it(`covers the "${surface}" surface`, () => {
      expect(workedExamplesSection.toLowerCase()).toContain(surface);
    });
  }

  it("pulls examples from the agent-types/coding/manifest.yaml worked example", () => {
    expect(workedExamplesSection).toContain("agent-types/coding/manifest.yaml");
  });
});

// ─── Rules section (acceptance criterion 3) ────────────────────────────────

describe("docs/agent-types.md — Rules section", () => {
  const rulesStart = content.indexOf("## Rules");
  const rulesSection = content.slice(rulesStart);

  it("states the FLOOR_TOOLS rule — floor tools are outside manifest authority", () => {
    expect(rulesSection).toContain("FLOOR_TOOLS");
    expect(rulesSection).toMatch(
      /outside (of )?(the )?manifest('s)? authority/i,
    );
  });

  it("states manifests never contain secret values (keys-only env contract)", () => {
    expect(rulesSection).toMatch(/never contain(s)? secret values/i);
  });

  it("states new crons in published types ship enabled: false", () => {
    expect(rulesSection).toContain("enabled: false");
    expect(rulesSection).toMatch(
      /new crons?.{0,80}(ship|must).{0,40}(disabled|enabled: false)/is,
    );
  });

  it("documents the resolution model — built-in registry wins, custom types cannot shadow built-in names", () => {
    expect(rulesSection).toMatch(/built-in/i);
    expect(rulesSection).toMatch(/shadow/i);
  });
});

// ─── CLAUDE.md Reference index ─────────────────────────────────────────────

describe("CLAUDE.md — Reference index includes docs/agent-types.md", () => {
  const claudeMdPath = join(import.meta.dir, "..", "CLAUDE.md");
  const claudeMdContent = readFileSync(claudeMdPath, "utf-8");

  it("has a docs/agent-types.md bullet in the Reference section", () => {
    expect(claudeMdContent).toContain("docs/agent-types.md");
  });
});
