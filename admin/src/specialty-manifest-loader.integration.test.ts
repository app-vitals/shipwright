/**
 * admin/src/specialty-manifest-loader.integration.test.ts
 * Integration tests for SpecialtyRegistry's real-disk-backed default reader
 * and lister.
 *
 * Unlike specialty-manifest-loader.unit.test.ts (which injects a fake
 * read/list and never touches the filesystem), these cases construct
 * `SpecialtyRegistry` with no injected dependencies, so it falls through to
 * `defaultManifestReader`/`defaultTypeDirLister` and reads the real,
 * committed specialties/ directory from disk. This is a genuine I/O-boundary
 * crossing — see docs/testing.md for the integration-layer contract.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpecialtyRegistry } from "@app-vitals/agent-admin/specialty-manifest-loader";
import { SHIPWRIGHT_SPECIALTIES_DIR } from "./main.ts";

// The platform package's own default dir is inside node_modules; Shipwright's
// composition root (main.ts) points it at the repo-root specialties/, so these
// cases read from the same dir with no injected reader or lister.
const typesDir = SHIPWRIGHT_SPECIALTIES_DIR;

describe("SpecialtyRegistry", () => {
  it("loads the real committed coding manifest from disk via the default reader", () => {
    // No injected reader — exercises defaultManifestReader against the real
    // specialties/coding/manifest.yaml so a broken repo-root path is caught.
    const registry = new SpecialtyRegistry({ typesDir });
    const manifest = registry.getManifest("coding");
    expect(manifest.metadata.name).toBe("coding");
    expect(manifest.crons.length).toBeGreaterThan(0);
  });

  it("listTypes discovers the real committed specialties/ dir via the default list fn", () => {
    // No injected list/read — exercises the real disk-backed discovery so a
    // broken repo-root path or missing coding manifest is caught.
    const registry = new SpecialtyRegistry({ typesDir });
    const types = registry.listTypes();
    expect(types.length).toBeGreaterThan(0);
    expect(types.some((t) => t.name === "coding")).toBe(true);
  });

  it("lists and loads the real committed specialist manifest without falling back to coding", () => {
    const registry = new SpecialtyRegistry({ typesDir });
    expect(registry.listTypes().some((t) => t.name === "specialist")).toBe(
      true,
    );
    const manifest = registry.getManifest("specialist");
    expect(manifest.metadata.name).toBe("specialist");
    expect(manifest.crons).toEqual([]);
  });
});

describe("SpecialtyRegistry with a fixture specialties dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "specialties-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const real = new SpecialtyRegistry({ typesDir }).getManifest("coding");
  const writeType = (name: string) => {
    mkdirSync(join(dir, name));
    const yaml = `apiVersion: shipwright.dev/v1alpha1
kind: Specialty
metadata:
  name: ${name}
  displayName: Fixture ${name}
  description: fixture
  version: 1.0.0
  skills: []
identity:
  templatesDir: workspace/
crons: []
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
    writeFileSync(join(dir, name, "manifest.yaml"), yaml);
  };
  writeType("alpha");
  writeType("beta");

  it("reads, lists and falls back within the fixture dir", () => {
    expect(real.metadata.name).toBe("coding");
    const registry = new SpecialtyRegistry({
      typesDir: dir,
      defaultTypeName: "beta",
      warn: () => {},
    });
    expect(registry.getManifest("alpha").metadata.name).toBe("alpha");
    expect(registry.getManifest("unknown").metadata.name).toBe("beta");
    expect(
      registry
        .listTypes()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["alpha", "beta"]);
  });
});
