/**
 * admin/src/agent-type-manifest-loader.unit.test.ts
 * Unit tests for AgentTypeRegistry — the disk-backed resolver from an agent's
 * typeName to its parsed manifest, with the unknown-type "coding" fallback.
 *
 * Pure logic against an injected reader/warner — no filesystem, no DB. See
 * docs/testing.md for the unit-layer contract.
 */

import { describe, expect, it } from "bun:test";
import {
  AgentTypeRegistry,
  DEFAULT_AGENT_TYPE_NAME,
} from "./agent-type-manifest-loader.ts";

/** A minimal valid AgentType manifest YAML for a given type name. */
function manifestYaml(name: string): string {
  return `apiVersion: shipwright.dev/v1alpha1
kind: AgentType
metadata:
  name: ${name}
  displayName: ${name}
  description: test manifest
  version: 1.0.0
  skills: []
identity:
  templatesDir: agent/workspace/
crons:
  - name: ${name}-cron
    schedule: "* * * * *"
    prompt: /noop
plugins: []
tools: []
env:
  required: []
  optional: []
members: []
repos: []
chat: true
voice: true
`;
}

describe("AgentTypeRegistry", () => {
  it("resolves a known typeName to its parsed manifest", () => {
    const registry = new AgentTypeRegistry({
      read: (t) => manifestYaml(t),
    });
    const manifest = registry.getManifest("coding");
    expect(manifest.metadata.name).toBe("coding");
    expect(manifest.crons[0]?.name).toBe("coding-cron");
  });

  it("falls back to the coding manifest with a warning for an unknown typeName", () => {
    const warnings: string[] = [];
    const registry = new AgentTypeRegistry({
      read: (t) => {
        if (t === DEFAULT_AGENT_TYPE_NAME) return manifestYaml("coding");
        throw new Error(`ENOENT: no manifest for ${t}`);
      },
      warn: (m) => warnings.push(m),
    });

    const manifest = registry.getManifest("renamed-type");

    expect(manifest.metadata.name).toBe("coding");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("renamed-type");
    expect(warnings[0]).toContain("coding");
  });

  it("throws (does not silently no-op) when the coding fallback itself cannot load", () => {
    const registry = new AgentTypeRegistry({
      read: () => {
        throw new Error("ENOENT: coding manifest missing");
      },
      warn: () => {},
    });

    // Requesting the default type when it can't load must surface a hard error
    // rather than degrade into an empty cron set that would strip system crons.
    expect(() => registry.getManifest("coding")).toThrow();
  });

  it("caches a resolved manifest — the reader is called once per type", () => {
    let reads = 0;
    const registry = new AgentTypeRegistry({
      read: (t) => {
        reads++;
        return manifestYaml(t);
      },
    });

    registry.getManifest("coding");
    registry.getManifest("coding");

    expect(reads).toBe(1);
  });

  it("loads the real committed coding manifest from disk via the default reader", () => {
    // No injected reader — exercises defaultManifestReader against the real
    // agent-types/coding/manifest.yaml so a broken repo-root path is caught.
    const registry = new AgentTypeRegistry();
    const manifest = registry.getManifest("coding");
    expect(manifest.metadata.name).toBe("coding");
    expect(manifest.crons.length).toBeGreaterThan(0);
  });
});
