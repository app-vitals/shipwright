/**
 * agent-types/coding/manifest.content.test.ts
 *
 * Content-layer tests for agent-types/coding/manifest.yaml — the AgentType
 * manifest expressing today's coding agent defaults in the Agent Type format
 * (ATS-2.1). No real I/O boundary beyond reading the two static source files
 * being compared; this is a content-assertion test, not integration.
 *
 * Parity note (temporary): this test compares the manifest's crons[] against
 * the still-live admin/src/system-crons.ts SYSTEM_CRONS array. Both sources
 * exist side by side until ATS-3.2 cuts SYSTEM_CRONS over to read from the
 * manifest and deletes the TS array — at that point this parity assertion is
 * retired and replaced by a golden regression test against the manifest
 * alone. Do not delete this test before ATS-3.2 lands.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  type AgentTypeManifest,
  parseAgentTypeManifest,
} from "../../admin/src/agent-type-registry.ts";
import { SYSTEM_CRONS } from "../../admin/src/system-crons.ts";

const MANIFEST_PATH = join(import.meta.dir, "manifest.yaml");
const rawContent = readFileSync(MANIFEST_PATH, "utf-8");

// ─── Acceptance criterion 1 — schema-clean load ────────────────────────────

describe("agent-types/coding/manifest.yaml — parses via AgentTypeRegistry", () => {
  it("parses without throwing", () => {
    expect(() => parseAgentTypeManifest(rawContent)).not.toThrow();
  });

  let manifest: AgentTypeManifest;
  it("produces a manifest object", () => {
    manifest = parseAgentTypeManifest(rawContent);
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

  it("matches the SYSTEM_CRONS source count (sanity check on the fixture itself)", () => {
    expect(SYSTEM_CRONS).toHaveLength(13);
  });
});

// ─── Acceptance criterion 2 — byte-match parity vs SYSTEM_CRONS ────────────

describe("agent-types/coding/manifest.yaml — cron parity vs SYSTEM_CRONS (temporary, retired in ATS-3.2)", () => {
  const manifest = parseAgentTypeManifest(rawContent);

  it("has a manifest cron entry for every SYSTEM_CRONS name, in the same order", () => {
    const manifestNames = manifest.crons.map((c) => c.name);
    const systemCronNames = SYSTEM_CRONS.map((c) => c.name);
    expect(manifestNames).toEqual(systemCronNames);
  });

  for (const systemCron of SYSTEM_CRONS) {
    describe(`cron "${systemCron.name}"`, () => {
      it("byte-matches schedule, prompt, preCheck, silent, enabled, parentCron", () => {
        const manifestCron = manifest.crons.find(
          (c) => c.name === systemCron.name,
        );
        expect(manifestCron).toBeDefined();
        if (!manifestCron) return;

        expect(manifestCron.schedule).toBe(systemCron.schedule);
        expect(manifestCron.prompt).toBe(systemCron.prompt);
        expect(manifestCron.preCheck).toBe(systemCron.preCheck);
        expect(manifestCron.silent).toBe(systemCron.silent ?? false);
        expect(manifestCron.enabled).toBe(systemCron.enabled);
        expect(manifestCron.parentCron).toBe(systemCron.parentCron);
      });
    });
  }
});

// ─── Tools parity vs DEFAULT_AGENT_TOOLS (resolved decision A) ─────────────

describe("agent-types/coding/manifest.yaml — tools parity vs DEFAULT_AGENT_TOOLS", () => {
  it("byte-matches lib/agent-default-tools.ts DEFAULT_AGENT_TOOLS", async () => {
    const { DEFAULT_AGENT_TOOLS } = await import(
      "../../lib/agent-default-tools.ts"
    );
    const manifest = parseAgentTypeManifest(rawContent);
    expect(manifest.tools).toEqual(DEFAULT_AGENT_TOOLS);
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
