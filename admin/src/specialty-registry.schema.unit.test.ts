/**
 * admin/src/specialty-registry.schema.unit.test.ts
 * Regenerates the Specialty JSON Schema in-memory from its Zod source and
 * diffs it (deep-equal, not string-equal) against the committed
 * docs/schemas/specialty.schema.json artifact. This guarantees the
 * committed artifact can never silently drift from the Zod source —
 * `scripts/generate-specialty-schema.ts` must be re-run (and its output
 * re-committed) whenever SpecialtyManifestSchema changes.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { buildSpecialtyJsonSchema } from "./specialty-registry.ts";

// docs/schemas/ in the monorepo, agent-types/ in the extracted layout.
const committedSchemaPath = [
  join(import.meta.dir, "..", "..", "docs", "schemas", "specialty.schema.json"),
  join(import.meta.dir, "..", "..", "agent-types", "specialty.schema.json"),
].find((candidate) => existsSync(candidate)) as string;

describe("docs/schemas/specialty.schema.json", () => {
  it("matches the JSON Schema regenerated from SpecialtyManifestSchema", () => {
    const regenerated = buildSpecialtyJsonSchema();
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
