/**
 * admin/src/agent-type-registry.schema.unit.test.ts
 * Regenerates the AgentType JSON Schema in-memory from its Zod source and
 * diffs it (deep-equal, not string-equal) against the committed
 * docs/schemas/agent-type.schema.json artifact. This guarantees the
 * committed artifact can never silently drift from the Zod source —
 * `scripts/generate-agent-type-schema.ts` must be re-run (and its output
 * re-committed) whenever AgentTypeManifestSchema changes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { buildAgentTypeJsonSchema } from "./agent-type-registry.ts";

const committedSchemaPath = join(
  import.meta.dir,
  "..",
  "..",
  "docs",
  "schemas",
  "agent-type.schema.json",
);

describe("docs/schemas/agent-type.schema.json", () => {
  it("matches the JSON Schema regenerated from AgentTypeManifestSchema", () => {
    const regenerated = buildAgentTypeJsonSchema();
    const committedRaw = readFileSync(committedSchemaPath, "utf-8");
    const committed = JSON.parse(committedRaw);
    expect(regenerated).toEqual(committed);
  });

  it("ends with exactly one trailing newline (matches the generator's write format)", () => {
    const committedRaw = readFileSync(committedSchemaPath, "utf-8");
    expect(committedRaw.endsWith("\n")).toBe(true);
    expect(committedRaw.endsWith("\n\n")).toBe(false);
  });
});
