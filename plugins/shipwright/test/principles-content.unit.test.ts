/**
 * principles.md content tests — PRN-1.1
 *
 * Verifies the net-new unified principles file
 * (plugins/shipwright/references/principles.md) carries every required rule ID,
 * the correct per-entry fields, the entropy-scannable architecture-layering
 * entry, and none of the three removed rule IDs.
 *
 * Content-assertion only: existsSync/readFileSync, no I/O beyond local file
 * reads (mirrors plugin-absorption.test.ts).
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// plugins/shipwright/test/ → plugins/shipwright/
const pluginRoot = resolve(import.meta.dir, "..");

function pluginPath(...parts: string[]): string {
  return join(pluginRoot, ...parts);
}

const principlesPath = pluginPath("references", "principles.md");

function readPrinciples(): string {
  return readFileSync(principlesPath, "utf8");
}

/** Extract the markdown block for a `### \`<id>\`` entry, up to the next `###`/`##`. */
function entryBlock(content: string, id: string): string {
  const marker = `### \`${id}\``;
  const start = content.indexOf(marker);
  if (start === -1) return "";
  const rest = content.slice(start + marker.length);
  const next = rest.search(/\n#{2,3}\s/);
  return next === -1 ? rest : rest.slice(0, next);
}

// ── File exists ─────────────────────────────────────────────────────────────

describe("principles.md — file", () => {
  it("references/principles.md exists", () => {
    expect(existsSync(principlesPath)).toBe(true);
  });
});

// ── Required rule IDs present ────────────────────────────────────────────────

describe("principles.md — required rule IDs present", () => {
  const requiredIds = [
    // dead_code
    "dead_exports",
    "commented_out_blocks",
    "unreferenced_files",
    // todo_debt
    "todo_fixme_hack",
    "stale_todo",
    // docs
    "undocumented_exports",
    "missing_readme_section",
    // security
    "hardcoded_secrets",
    "authn_authz_boundary",
    "webhook_signature_verification",
    "injection_at_trust_boundary",
    "least_privilege_tokens",
    "secrets_in_logs",
    // inconsistent patterns
    "duplicated_utility",
    // architecture
    "architecture_layering",
    // testing (t4 intentionally skipped — elevated to architecture)
    "t1_no_global_mocking",
    "t2_clock_injection",
    "t3_recorded_fixture_pattern",
    "t5_no_duplicate_coverage",
    "t6_layer_speed_mismatch",
    "t7_canary_safety",
    "t8_file_naming_convention",
    "t9_new_service_canary_wiring",
    "t10_untested_critical_logic",
  ];

  for (const id of requiredIds) {
    it(`contains an entry for \`${id}\``, () => {
      expect(readPrinciples()).toContain(`### \`${id}\``);
    });
  }

  it("contains at least one error-handling entry", () => {
    expect(readPrinciples()).toContain("### `error_handling");
  });

  it("contains at least one data-layer entry", () => {
    expect(readPrinciples()).toContain("### `data_layer");
  });

  it("does not define a testing-domain t4 entry (elevated to architecture)", () => {
    expect(readPrinciples()).not.toContain("### `t4_");
  });
});

// ── Removed rule IDs absent ──────────────────────────────────────────────────

describe("principles.md — removed rule IDs absent", () => {
  const removedIds = ["ungated_outbound", "missing_test_file", "empty_test_file"];

  for (const id of removedIds) {
    it(`does not mention \`${id}\` anywhere`, () => {
      expect(readPrinciples()).not.toContain(id);
    });
  }
});

// ── Architecture-layering entry is entropy-scannable ─────────────────────────

describe("principles.md — architecture_layering entry", () => {
  it("has a Detection field", () => {
    const block = entryBlock(readPrinciples(), "architecture_layering");
    expect(block).toContain("**Detection:**");
  });

  it("is PR-worthy: true", () => {
    const block = entryBlock(readPrinciples(), "architecture_layering");
    expect(block).toContain("**PR-worthy:** true");
  });

  it("carries a HITL classification", () => {
    const block = entryBlock(readPrinciples(), "architecture_layering");
    expect(block).toContain("**HITL:**");
  });
});

// ── webhook_signature_verification entry is entropy-scannable ───────────────

describe("principles.md — webhook_signature_verification entry", () => {
  it("has a Detection field", () => {
    const block = entryBlock(readPrinciples(), "webhook_signature_verification");
    expect(block).toContain("**Detection:**");
  });

  it("is PR-worthy: true", () => {
    const block = entryBlock(readPrinciples(), "webhook_signature_verification");
    expect(block).toContain("**PR-worthy:** true");
  });

  it("has HITL: always", () => {
    const block = entryBlock(readPrinciples(), "webhook_signature_verification");
    expect(block).toContain("**HITL:** always");
  });
});

// ── Per-entry required fields (spot-check one per domain) ─────────────────────

describe("principles.md — required per-entry fields", () => {
  const domainSamples: Array<{ id: string; domain: string; severity: string }> = [
    { id: "dead_exports", domain: "dead_code", severity: "medium" },
    { id: "stale_todo", domain: "todo_debt", severity: "high" },
    { id: "undocumented_exports", domain: "docs", severity: "low" },
    { id: "hardcoded_secrets", domain: "security", severity: "high" },
    { id: "architecture_layering", domain: "architecture", severity: "high" },
    { id: "t1_no_global_mocking", domain: "testing", severity: "high" },
  ];

  for (const { id, domain, severity } of domainSamples) {
    it(`\`${id}\` has Domain, Severity, and statement prose`, () => {
      const block = entryBlock(readPrinciples(), id);
      expect(block).toContain(`**Domain:** ${domain}`);
      expect(block).toContain(`**Severity:** ${severity}`);
      // statement prose: non-field text present in the block
      const prose = block
        .split("\n")
        .filter((l) => l.trim() && !l.trim().startsWith("**"));
      expect(prose.length).toBeGreaterThan(0);
    });
  }
});

// ── Judgment-only entries carry no Detection field ──────────────────────────

describe("principles.md — judgment-only entries omit Detection", () => {
  const judgmentOnly = [
    "t1_no_global_mocking",
    "t5_no_duplicate_coverage",
    "error_handling",
    "authn_authz_boundary",
    "injection_at_trust_boundary",
    "least_privilege_tokens",
    "secrets_in_logs",
  ];

  for (const id of judgmentOnly) {
    it(`\`${id}\` has no Detection field`, () => {
      const block = entryBlock(readPrinciples(), id);
      expect(block).not.toContain("**Detection:**");
    });
  }
});

// ── Cassette/VCR terminology rename regression guard ─────────────────────────

describe("principles.md — no cassette/VCR terminology", () => {
  it("does not contain 'cassette' (case-insensitive)", () => {
    expect(readPrinciples().toLowerCase()).not.toContain("cassette");
  });

  it("does not contain 'VCR' (case-insensitive)", () => {
    expect(readPrinciples().toLowerCase()).not.toContain("vcr");
  });

  it("uses 'recorded fixture doubles' terminology", () => {
    expect(readPrinciples().toLowerCase()).toContain("recorded fixture double");
  });
});
