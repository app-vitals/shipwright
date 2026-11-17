/**
 * consolidation-fix content tests — PLU-4.4 origin provenance.
 * Content-assertion only: local file reads.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("PLU-4.4 origin provenance", () => {
  it("files tasks with originKind skill and its own name as originRef", () => {
    const text = readFileSync(join(import.meta.dir, "SKILL.md"), "utf8");
    expect(text).toContain('"originKind": "skill"');
    expect(text).toContain('"originRef": "consolidation-fix"');
  });

  it("still writes source unchanged", () => {
    const text = readFileSync(join(import.meta.dir, "SKILL.md"), "utf8");
    expect(text).toContain('"source": "consolidation-fix"');
  });
});
