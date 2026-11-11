/**
 * plugins/shipwright/scripts/prompt-audit/fingerprint.unit.test.ts
 */

import { describe, expect, test } from "bun:test";
import { fingerprint, normalizeEvidence } from "./fingerprint.ts";

const base = { rule: "dup-description", file: "skills/a/SKILL.md", evidence: "Same text as skills/b" };

describe("fingerprint", () => {
  test("is 12 hex chars and deterministic", () => {
    const fp = fingerprint("listing", base);
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint("listing", base)).toBe(fp);
  });

  test("is stable across line-number shifts", () => {
    const a = fingerprint("always", { ...base, evidence: "line 12: verbose preamble" });
    const b = fingerprint("always", { ...base, evidence: "line 48: verbose preamble" });
    const c = fingerprint("always", { ...base, evidence: "CLAUDE.md:12:3 verbose preamble" });
    const d = fingerprint("always", { ...base, evidence: "CLAUDE.md:99:1 verbose preamble" });
    expect(a).toBe(b);
    expect(c).toBe(d);
  });

  test("ignores whitespace and case in evidence", () => {
    expect(fingerprint("always", { ...base, evidence: "Foo   Bar\n" })).toBe(
      fingerprint("always", { ...base, evidence: "foo bar" }),
    );
  });

  test("changes with class, rule, file, or evidence", () => {
    const fp = fingerprint("always", base);
    expect(fingerprint("listing", base)).not.toBe(fp);
    expect(fingerprint("always", { ...base, rule: "other" })).not.toBe(fp);
    expect(fingerprint("always", { ...base, file: "x.md" })).not.toBe(fp);
    expect(fingerprint("always", { ...base, evidence: "different" })).not.toBe(fp);
  });
});

describe("normalizeEvidence", () => {
  test("strips line ranges", () => {
    expect(normalizeEvidence("lines 3-9 are redundant")).toBe("are redundant");
  });
});
