/**
 * consolidation-fix content tests — PLU-4.4 origin provenance (updated by PCR-3.2: cron-run origin).
 * Content-assertion only: local file reads.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("PLU-4.4 origin provenance", () => {
  it("files tasks with originKind cron and the patrol cron id as originRef", () => {
    const text = readFileSync(join(import.meta.dir, "SKILL.md"), "utf8");
    expect(text).toContain('"originKind": "cron"');
    expect(text).toContain('"originRef": "consolidation-patrol"');
  });

  it("still writes source unchanged", () => {
    const text = readFileSync(join(import.meta.dir, "SKILL.md"), "utf8");
    expect(text).toContain('"source": "consolidation-fix"');
  });
});
