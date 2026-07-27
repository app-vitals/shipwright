/**
 * admin/src/agent-type-manifest-loader.integration.test.ts
 * Integration tests for AgentTypeRegistry's real-disk-backed default reader
 * and lister.
 *
 * Unlike agent-type-manifest-loader.unit.test.ts (which injects a fake
 * read/list and never touches the filesystem), these cases construct
 * `AgentTypeRegistry` with no injected dependencies, so it falls through to
 * `defaultManifestReader`/`defaultTypeDirLister` and reads the real,
 * committed agent-types/ directory from disk. This is a genuine I/O-boundary
 * crossing — see docs/testing.md for the integration-layer contract.
 */

import { describe, expect, it } from "bun:test";
import { AgentTypeRegistry } from "./agent-type-manifest-loader.ts";

describe("AgentTypeRegistry", () => {
  it("loads the real committed coding manifest from disk via the default reader", () => {
    // No injected reader — exercises defaultManifestReader against the real
    // agent-types/coding/manifest.yaml so a broken repo-root path is caught.
    const registry = new AgentTypeRegistry();
    const manifest = registry.getManifest("coding");
    expect(manifest.metadata.name).toBe("coding");
    expect(manifest.crons.length).toBeGreaterThan(0);
  });

  it("listTypes discovers the real committed agent-types/ dir via the default list fn", () => {
    // No injected list/read — exercises the real disk-backed discovery so a
    // broken repo-root path or missing coding manifest is caught.
    const registry = new AgentTypeRegistry();
    const types = registry.listTypes();
    expect(types.length).toBeGreaterThan(0);
    expect(types.some((t) => t.name === "coding")).toBe(true);
  });
});
