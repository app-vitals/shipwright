/**
 * agent-types/specialist/manifest.content.test.ts
 *
 * Content-layer tests for agent-types/specialist/manifest.yaml — the generic,
 * non-coding AgentType (SAT-1.1). Content assertions over a static source
 * file, not integration.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgentTypeManifest } from "../../admin/src/agent-type-registry.ts";

const rawContent = readFileSync(
  join(import.meta.dir, "manifest.yaml"),
  "utf-8",
);

describe("agent-types/specialist/manifest.yaml — parses via AgentTypeRegistry", () => {
  it("parses without throwing", () => {
    expect(() => parseAgentTypeManifest(rawContent)).not.toThrow();
  });

  it("has the expected apiVersion and kind", () => {
    const manifest = parseAgentTypeManifest(rawContent);
    expect(manifest.apiVersion).toBe("shipwright.dev/v1alpha1");
    expect(manifest.kind).toBe("AgentType");
  });
});

describe("agent-types/specialist/manifest.yaml — required top-level sections", () => {
  const manifest = parseAgentTypeManifest(rawContent);

  it("has specialist metadata with no skills", () => {
    expect(manifest.metadata.name).toBe("specialist");
    expect(manifest.metadata.displayName).toBe("Specialist Agent");
    expect(manifest.metadata.version).toBe("1.0.0");
    expect(manifest.metadata.skills).toEqual([]);
  });

  it("has an identity section with templatesDir agent/workspace/", () => {
    expect(manifest.identity.templatesDir).toBe("agent/workspace/");
  });

  it("has empty crons (learn-dream needs the shipwright plugin)", () => {
    expect(manifest.crons).toEqual([]);
  });

  it("has no plugins, in particular no shipwright plugin", () => {
    expect(manifest.plugins).toEqual([]);
    expect(manifest.plugins).not.toContain("shipwright");
  });

  it("has empty members and repos", () => {
    expect(manifest.members).toEqual([]);
    expect(manifest.repos).toEqual([]);
  });

  it("has chat and voice enabled", () => {
    expect(manifest.chat).toBe(true);
    expect(manifest.voice).toBe(true);
  });
});

describe("agent-types/specialist/manifest.yaml — tools set", () => {
  it("declares Bash, WebSearch, WebFetch, Agent (no Monitor)", () => {
    const manifest = parseAgentTypeManifest(rawContent);
    expect(manifest.tools).toEqual(["Bash", "WebSearch", "WebFetch", "Agent"]);
  });
});

describe("agent-types/specialist/manifest.yaml — no secret values (public repo)", () => {
  it("has no `value:` key anywhere in the raw YAML", () => {
    expect(rawContent).not.toMatch(/^\s*value:/m);
  });

  it("has no `default:` key on an env entry (keys-only contract)", () => {
    expect(rawContent).not.toMatch(/^\s*default:\s*["'A-Za-z0-9]/m);
  });

  it("every env entry has key/description/secret only", () => {
    const manifest = parseAgentTypeManifest(rawContent);
    for (const entry of [...manifest.env.required, ...manifest.env.optional]) {
      expect(Object.keys(entry).sort()).toEqual([
        "description",
        "key",
        "secret",
      ]);
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

describe("agent-types/specialist/manifest.yaml — env contract", () => {
  const manifest = parseAgentTypeManifest(rawContent);

  it("requires only CLAUDE_CODE_OAUTH_TOKEN, as a secret", () => {
    expect(manifest.env.required).toHaveLength(1);
    expect(manifest.env.required[0]?.key).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(manifest.env.required[0]?.secret).toBe(true);
  });

  it("lists the same optional keys as the coding manifest", () => {
    const coding = parseAgentTypeManifest(
      readFileSync(join(import.meta.dir, "../coding/manifest.yaml"), "utf-8"),
    );
    expect(manifest.env.optional).toEqual(coding.env.optional);
  });

  it("has no duplicate keys across required+optional", () => {
    const allKeys = [
      ...manifest.env.required.map((e) => e.key),
      ...manifest.env.optional.map((e) => e.key),
    ];
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });
});
