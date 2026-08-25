/**
 * agent-types/coding/manifest.content.test.ts
 *
 * Content-layer tests for agent-types/coding/manifest.yaml — the AgentType
 * manifest expressing today's coding agent defaults in the Agent Type format
 * (ATS-2.1). No real I/O boundary beyond reading the two static source files
 * being compared; this is a content-assertion test, not integration.
 *
 * ATS-3.2 note: this test previously compared the manifest's crons[] against
 * the hardcoded admin/src/system-crons.ts SYSTEM_CRONS array as a temporary
 * parity check. ATS-3.2 cut cron reconciliation over to read this manifest
 * (via AgentTypeRegistry) and deleted the TS array, so that parity assertion
 * has been retired. The manifest→row golden regression now lives in
 * admin/src/agent-cron-jobs.integration.test.ts (GOLDEN_CODING_CRONS).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgentTypeManifest } from "../../admin/src/agent-type-registry.ts";

const MANIFEST_PATH = join(import.meta.dir, "manifest.yaml");
const rawContent = readFileSync(MANIFEST_PATH, "utf-8");

// ─── Acceptance criterion 1 — schema-clean load ────────────────────────────

describe("agent-types/coding/manifest.yaml — parses via AgentTypeRegistry", () => {
  it("parses without throwing", () => {
    expect(() => parseAgentTypeManifest(rawContent)).not.toThrow();
  });

  it("produces a manifest object", () => {
    const manifest = parseAgentTypeManifest(rawContent);
    expect(manifest).toBeDefined();
  });

  it("has the expected apiVersion and kind", () => {
    const manifest = parseAgentTypeManifest(rawContent);
    expect(manifest.apiVersion).toBe("shipwright.dev/v1alpha1");
    expect(manifest.kind).toBe("AgentType");
  });
});

// ─── Acceptance criterion 4 — required top-level sections present ─────────

describe("agent-types/coding/manifest.yaml — required top-level sections", () => {
  const manifest = parseAgentTypeManifest(rawContent);

  it("has a metadata section", () => {
    expect(manifest.metadata).toBeDefined();
    expect(manifest.metadata.name).toBe("coding");
  });

  it("has an identity section with templatesDir agent/workspace/", () => {
    expect(manifest.identity).toBeDefined();
    expect(manifest.identity.templatesDir).toBe("agent/workspace/");
  });

  it("has a crons array", () => {
    expect(Array.isArray(manifest.crons)).toBe(true);
  });

  it("has a plugins array containing the shipwright plugin", () => {
    expect(manifest.plugins).toContain("shipwright");
  });

  it("has a tools array", () => {
    expect(Array.isArray(manifest.tools)).toBe(true);
  });

  it("has an env section with required and optional arrays", () => {
    expect(manifest.env).toBeDefined();
    expect(Array.isArray(manifest.env.required)).toBe(true);
    expect(Array.isArray(manifest.env.optional)).toBe(true);
  });

  it("has an empty members array", () => {
    expect(manifest.members).toEqual([]);
  });

  it("has an empty repos array", () => {
    expect(manifest.repos).toEqual([]);
  });

  it("has chat and voice booleans, both enabled", () => {
    expect(manifest.chat).toBe(true);
    expect(manifest.voice).toBe(true);
  });
});

// ─── Acceptance criterion 2 — exactly 13 cron entries ──────────────────────

describe("agent-types/coding/manifest.yaml — cron count", () => {
  it("has exactly 13 cron entries", () => {
    const manifest = parseAgentTypeManifest(rawContent);
    expect(manifest.crons).toHaveLength(13);
  });
});

// ─── Tools set (resolved decision A) ───────────────────────────────────────
//
// This manifest is the single source of truth for the coding agent's tool
// set as of ATS-3.3 — the former hardcoded tools constant module has been
// deleted; both admin/src/agents-api.ts (POST /agents) and
// scripts/seed-dev-agent.ts now resolve tools from this manifest via
// AgentTypeRegistry instead. This test pins the expected tool set directly
// so a regression here fails loudly rather than silently drifting.

describe("agent-types/coding/manifest.yaml — tools set", () => {
  it("declares the expected full tool set", () => {
    const manifest = parseAgentTypeManifest(rawContent);
    expect(manifest.tools).toEqual([
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash",
      "WebSearch",
      "WebFetch",
      "Skill",
      "Agent",
    ]);
  });
});

// ─── Acceptance criterion 3 — zero secret values anywhere in the file ──────

describe("agent-types/coding/manifest.yaml — no secret values (public repo)", () => {
  it("has no `value:` key anywhere in the raw YAML", () => {
    expect(rawContent).not.toMatch(/^\s*value:/m);
  });

  it("has no `default:` key on an env entry (keys-only contract)", () => {
    // A bare top-level "default:" key is not part of the schema at all; this
    // guards against someone hand-adding one to an env entry by mistake.
    expect(rawContent).not.toMatch(/^\s*default:\s*["'A-Za-z0-9]/m);
  });

  it("every required env entry has key/description/secret only — no value", () => {
    const manifest = parseAgentTypeManifest(rawContent);
    for (const entry of manifest.env.required) {
      expect(Object.keys(entry).sort()).toEqual(
        ["description", "key", "secret"].sort(),
      );
    }
  });

  it("every optional env entry has key/description/secret only — no value", () => {
    const manifest = parseAgentTypeManifest(rawContent);
    for (const entry of manifest.env.optional) {
      expect(Object.keys(entry).sort()).toEqual(
        ["description", "key", "secret"].sort(),
      );
    }
  });

  it("does not contain common secret-value patterns (sk-, xox, ghp_, AKIA, PEM headers)", () => {
    const suspiciousPatterns = [
      /sk-[a-zA-Z0-9]{10,}/,
      /xox[baprs]-[a-zA-Z0-9-]+/,
      /ghp_[a-zA-Z0-9]{20,}/,
      /AKIA[0-9A-Z]{16}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    ];
    for (const pattern of suspiciousPatterns) {
      expect(rawContent).not.toMatch(pattern);
    }
  });
});

// ─── env contract shape (CLAUDE_CODE_OAUTH_TOKEN required; GH_TOKEN + voice/chat optional) ─

describe("agent-types/coding/manifest.yaml — env contract", () => {
  const manifest = parseAgentTypeManifest(rawContent);

  it("requires CLAUDE_CODE_OAUTH_TOKEN as a secret", () => {
    const entry = manifest.env.required.find(
      (e) => e.key === "CLAUDE_CODE_OAUTH_TOKEN",
    );
    expect(entry).toBeDefined();
    expect(entry?.secret).toBe(true);
  });

  it("lists GH_TOKEN as optional and secret", () => {
    const entry = manifest.env.optional.find((e) => e.key === "GH_TOKEN");
    expect(entry).toBeDefined();
    expect(entry?.secret).toBe(true);
  });

  it("only CLAUDE_CODE_OAUTH_TOKEN is required (matches brief: GH_TOKEN + voice/chat vars are optional)", () => {
    expect(manifest.env.required.map((e) => e.key)).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
  });

  it("has no duplicate keys across required+optional", () => {
    const allKeys = [
      ...manifest.env.required.map((e) => e.key),
      ...manifest.env.optional.map((e) => e.key),
    ];
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });
});

// ─── error-patrol-maintenance cron — chaining instruction ──────────────────

describe("agent-types/coding/manifest.yaml — error-patrol-maintenance chaining", () => {
  it("error-patrol-maintenance prompt contains explicit chaining instruction", () => {
    const manifest = parseAgentTypeManifest(rawContent);
    const errorPatrol = manifest.crons.find(
      (c) => c.name === "error-patrol-maintenance",
    );
    expect(errorPatrol).toBeDefined();

    // The prompt should explicitly instruct the model to invoke each command
    // immediately after the previous one finishes, and not to treat a
    // command's own "run /X next" output as a stop signal.
    const chainingKeywords = [
      "invoke each one immediately",
      "Do not stop after",
      "Continue automatically",
    ];

    const hasAllKeywords = chainingKeywords.every((keyword) =>
      errorPatrol?.prompt.includes(keyword),
    );
    expect(hasAllKeywords).toBe(true);
  });
});
