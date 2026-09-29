/**
 * decisions-registry.md content tests — DRU-1.1
 *
 * Verifies the new shared reference doc
 * (plugins/shipwright/references/decisions-registry.md) exists and describes
 * the decisions-registry pattern generically: the four-field entry schema
 * (a Pattern/Item "what this covers" field, Decision, Rationale, Revisit),
 * human-only ownership, the graceful-no-op-when-missing consumption
 * contract, judgment-based (not exact-string) matching, the
 * never-cached/always-re-checked-live rule, and pointers to both concrete
 * instances (consolidation-decisions.md and test-readiness-decisions.md).
 *
 * Content-assertion only: existsSync/readFileSync, no I/O beyond local file
 * reads (mirrors dependency-risk-analysis.content.test.ts).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REFERENCE_PATH = join(import.meta.dir, "decisions-registry.md");

let content: string;

beforeAll(() => {
  if (existsSync(REFERENCE_PATH)) {
    content = readFileSync(REFERENCE_PATH, "utf-8");
  } else {
    content = "";
  }
});

describe("decisions-registry.md — file exists and has content", () => {
  it("file exists", () => {
    expect(existsSync(REFERENCE_PATH)).toBe(true);
  });

  it("is non-empty", () => {
    expect(content.length).toBeGreaterThan(200);
  });
});

describe("decisions-registry.md — generic entry schema", () => {
  it("documents the Decision field", () => {
    expect(content).toContain("Decision");
  });

  it("documents the Rationale field", () => {
    expect(content).toContain("Rationale");
  });

  it("documents the Revisit field", () => {
    expect(content).toContain("Revisit");
  });

  it("names both instance-specific first-field names: Pattern and Item", () => {
    expect(content).toContain("Pattern");
    expect(content).toContain("Item");
  });

  it("describes the four-field ### entry shape", () => {
    expect(content).toContain("###");
  });
});

describe("decisions-registry.md — ownership", () => {
  it("documents human-only editing", () => {
    expect(content.toLowerCase()).toContain("human");
  });

  it("states the registry is never written by the consuming skill/agent", () => {
    const lower = content.toLowerCase();
    expect(
      lower.includes("never written") || lower.includes("not written by"),
    ).toBe(true);
  });
});

describe("decisions-registry.md — consumption contract", () => {
  it("documents a missing file is a graceful no-op, not an error", () => {
    const lower = content.toLowerCase();
    expect(lower).toContain("no-op");
    expect(lower).toContain("not an error");
  });

  it("documents parsing defensively without hardcoding exact heading structure", () => {
    const lower = content.toLowerCase();
    expect(lower).toContain("defensive");
  });

  it("documents judgment-based matching, not exact-string equality", () => {
    const lower = content.toLowerCase();
    expect(lower).toContain("judgment");
    expect(
      lower.includes("not exact") || lower.includes("not exact-string"),
    ).toBe(true);
  });

  it("documents the registry is never cached and always re-checked live", () => {
    const lower = content.toLowerCase();
    expect(lower).toContain("never cached");
    expect(
      lower.includes("re-checked live") || lower.includes("re-evaluated live"),
    ).toBe(true);
  });
});

describe("decisions-registry.md — points to both concrete instances", () => {
  it("points to .claude/shipwright/consolidation-decisions.md", () => {
    expect(content).toContain(".claude/shipwright/consolidation-decisions.md");
  });

  it("points to .claude/shipwright/test-readiness-decisions.md", () => {
    expect(content).toContain(".claude/shipwright/test-readiness-decisions.md");
  });

  it("names consolidation-scan and consolidation-fix as consumers of the consolidation instance", () => {
    expect(content).toContain("consolidation-scan");
    expect(content).toContain("consolidation-fix");
  });

  it("names test-inventory and test-fix as consumers of the test-readiness instance", () => {
    expect(content).toContain("test-inventory");
    expect(content).toContain("test-fix");
  });
});
