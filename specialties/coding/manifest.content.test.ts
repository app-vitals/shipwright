/**
 * specialties/coding/manifest.content.test.ts
 *
 * Content-layer tests for specialties/coding/manifest.yaml — the Specialty
 * manifest expressing today's coding agent defaults in the Specialty format
 * (ATS-2.1). No real I/O boundary beyond reading the two static source files
 * being compared; this is a content-assertion test, not integration.
 *
 * ATS-3.2 note: this test previously compared the manifest's crons[] against
 * the hardcoded admin/src/system-crons.ts SYSTEM_CRONS array as a temporary
 * parity check. ATS-3.2 cut cron reconciliation over to read this manifest
 * (via SpecialtyRegistry) and deleted the TS array, so that parity assertion
 * has been retired. The manifest→row golden regression now lives in
 * admin/src/agent-cron-jobs.coding.integration.test.ts (GOLDEN_CODING_CRONS).
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSpecialtyManifest } from "@app-vitals/agent-admin/specialty-registry";

const MANIFEST_PATH = join(import.meta.dir, "manifest.yaml");
const rawContent = readFileSync(MANIFEST_PATH, "utf-8");

// ─── Acceptance criterion 1 — schema-clean load ────────────────────────────

describe("specialties/coding/manifest.yaml — parses via SpecialtyRegistry", () => {
  it("parses without throwing", () => {
    expect(() => parseSpecialtyManifest(rawContent)).not.toThrow();
  });

  it("produces a manifest object", () => {
    const manifest = parseSpecialtyManifest(rawContent);
    expect(manifest).toBeDefined();
  });

  it("has the expected apiVersion and kind", () => {
    const manifest = parseSpecialtyManifest(rawContent);
    expect(manifest.apiVersion).toBe("shipwright.dev/v1alpha1");
    expect(manifest.kind).toBe("Specialty");
  });
});

// ─── Acceptance criterion 4 — required top-level sections present ─────────

describe("specialties/coding/manifest.yaml — required top-level sections", () => {
  const manifest = parseSpecialtyManifest(rawContent);

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

// ─── Acceptance criterion 2 — exactly 14 cron entries ──────────────────────

describe("specialties/coding/manifest.yaml — cron count", () => {
  it("has exactly 14 cron entries", () => {
    const manifest = parseSpecialtyManifest(rawContent);
    expect(manifest.crons).toHaveLength(14);
  });
});

// ─── PDR-4.1 — the autonomous plan-session phase cron ──────────────────────

describe("specialties/coding/manifest.yaml — shipwright-plan phase cron", () => {
  const manifest = parseSpecialtyManifest(rawContent);
  const planCron = manifest.crons.find((c) => c.name === "shipwright-plan");

  it("declares a shipwright-plan cron", () => {
    expect(planCron).toBeDefined();
  });

  it("is a child of shipwright-loop, like the other pipeline phases", () => {
    expect(planCron?.parentCron).toBe("shipwright-loop");
  });

  it("runs /shipwright:plan-session, silently", () => {
    expect(planCron?.prompt).toBe("/shipwright:plan-session");
    expect(planCron?.silent).toBe(true);
  });

  it("ships disabled (new system crons always ship disabled)", () => {
    expect(planCron?.enabled).toBe(false);
  });
});

// ─── Tools set (resolved decision A) ───────────────────────────────────────
//
// This manifest is the single source of truth for the coding agent's tool
// set as of ATS-3.3 — the former hardcoded tools constant module has been
// deleted; both the platform admin UI (POST /admin/agents) and
// scripts/seed-dev-agent.ts now resolve tools from this manifest via
// SpecialtyRegistry instead. This test pins the expected tool set directly
// so a regression here fails loudly rather than silently drifting.

describe("specialties/coding/manifest.yaml — tools set", () => {
  it("declares the expected full tool set", () => {
    const manifest = parseSpecialtyManifest(rawContent);
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
      "Monitor",
    ]);
  });
});

// ─── Acceptance criterion 3 — zero secret values anywhere in the file ──────

describe("specialties/coding/manifest.yaml — no secret values (public repo)", () => {
  it("has no `value:` key anywhere in the raw YAML", () => {
    expect(rawContent).not.toMatch(/^\s*value:/m);
  });

  it("has no `default:` key on an env entry (keys-only contract)", () => {
    // A bare top-level "default:" key is not part of the schema at all; this
    // guards against someone hand-adding one to an env entry by mistake.
    expect(rawContent).not.toMatch(/^\s*default:\s*["'A-Za-z0-9]/m);
  });

  it("every required env entry has key/description/secret only — no value", () => {
    const manifest = parseSpecialtyManifest(rawContent);
    for (const entry of manifest.env.required) {
      expect(Object.keys(entry).sort()).toEqual(
        ["description", "key", "secret"].sort(),
      );
    }
  });

  it("every optional env entry has key/description/secret only — no value", () => {
    const manifest = parseSpecialtyManifest(rawContent);
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

describe("specialties/coding/manifest.yaml — env contract", () => {
  const manifest = parseSpecialtyManifest(rawContent);

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

describe("specialties/coding/manifest.yaml — error-patrol-maintenance chaining", () => {
  it("error-patrol-maintenance prompt contains explicit chaining instruction", () => {
    const manifest = parseSpecialtyManifest(rawContent);
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

// ─── PAU-3.11 — prompt-audit-maintenance cron ──────────────────────────────

describe("specialties/coding/manifest.yaml — prompt-audit-maintenance cron", () => {
  const manifest = parseSpecialtyManifest(rawContent);
  const cron = manifest.crons.find(
    (c) => c.name === "prompt-audit-maintenance",
  );

  it("declares the cron with the scan + fix prompt, weekly schedule and preCheck", () => {
    expect(cron).toBeDefined();
    expect(cron?.schedule).toBe("0 7 * * 1");
    expect(cron?.prompt).toContain("/shipwright:prompt-scan --with-doctor");
    expect(cron?.prompt).toContain("/shipwright:prompt-fix");
    expect(cron?.preCheck).toBe("shipwright:check-prompt-audit.ts");
    expect(cron?.silent).toBe(true);
  });

  it("ships disabled", () => {
    expect(cron?.enabled).toBe(false);
  });
});

// ─── CET-1.3 — Shipwright owns the full coding workspace template set ──────

describe("specialties/coding/manifest.yaml — identity.templatesDir template set", () => {
  const manifest = parseSpecialtyManifest(rawContent);
  const templatesDir = join(
    import.meta.dir,
    "..",
    "..",
    manifest.identity.templatesDir,
  );
  // The platform's REQUIRED_TEMPLATES (runtime/setup.ts) plus the coding-owned
  // optional ones: SPECIALTY (pipeline text) and BOOTSTRAP (dev-loop ritual).
  const REQUIRED = [
    "CLAUDE.md.template",
    "SOUL.md.template",
    "IDENTITY.md.template",
  ];
  const CODING_OWNED = ["SPECIALTY.md.template", "BOOTSTRAP.md.template"];

  it("resolves to an existing directory", () => {
    expect(existsSync(templatesDir)).toBe(true);
  });

  it.each([...REQUIRED, ...CODING_OWNED, "CLAUDE-HITL.md.template"])(
    "provides a non-empty %s",
    (name) => {
      const path = join(templatesDir, name);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf-8").trim().length).toBeGreaterThan(0);
    },
  );

  it("SPECIALTY.md.template carries the full shipwright pipeline text", () => {
    const body = readFileSync(
      join(templatesDir, "SPECIALTY.md.template"),
      "utf-8",
    );
    for (const needle of [
      "/shipwright:plan-session",
      "/shipwright:dev-task",
      "/shipwright:review",
      "shipwright-loop",
      "SHIPWRIGHT_TASK_STORE_URL",
    ]) {
      expect(body).toContain(needle);
    }
  });

  it("the Dockerfile ships the whole templatesDir into the image", () => {
    const df = readFileSync(
      join(import.meta.dir, "..", "..", "agent", "Dockerfile"),
      "utf-8",
    );
    expect(df).toContain(
      "COPY --chown=1000:1000 agent/workspace ./agent/workspace",
    );
  });
});
