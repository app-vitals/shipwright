/**
 * AGR-1.9 — SpecialtyRegistry against the platform's fixture specialty.
 *
 * Real filesystem reads, no injected reader. Nothing here depends on a product
 * specialty, so it runs in the extracted tree as well as the monorepo.
 */

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SpecialtyRegistry } from "./specialty-manifest-loader.ts";

// agent/src/fixtures in the monorepo, runtime/fixtures in the extracted layout.
const FIXTURE_SPECIALTIES_DIR = [
  join(import.meta.dir, "..", "..", "agent", "src", "fixtures", "specialties"),
  join(import.meta.dir, "..", "..", "runtime", "fixtures", "specialties"),
].find((dir) => existsSync(dir)) as string;

function fixtureRegistry(warn: (m: string) => void = () => {}) {
  return new SpecialtyRegistry({
    typesDir: FIXTURE_SPECIALTIES_DIR,
    defaultTypeName: "fixture",
    warn,
  });
}

describe("SpecialtyRegistry with the fixture specialty", () => {
  it("loads the fixture manifest from disk", () => {
    const manifest = fixtureRegistry().getManifest("fixture");
    expect(manifest.metadata.name).toBe("fixture");
    expect(manifest.identity.templatesDir).toBe("templates/");
  });

  it("lists the fixture in the type picker", () => {
    expect(fixtureRegistry().listTypes()).toEqual([
      { name: "fixture", displayName: "Fixture Agent" },
    ]);
  });

  it("falls back to the fixture default for an unknown type, with a warning", () => {
    const warnings: string[] = [];
    const manifest = fixtureRegistry((m) => warnings.push(m)).getManifest(
      "renamed-type",
    );
    expect(manifest.metadata.name).toBe("fixture");
    expect(warnings).toHaveLength(1);
  });

  it("tryGetManifest does not fall back", () => {
    expect(fixtureRegistry().tryGetManifest("renamed-type")).toBeUndefined();
  });

  it("fails with an actionable error when the default specialty is not on disk", () => {
    const registry = new SpecialtyRegistry({
      typesDir: FIXTURE_SPECIALTIES_DIR,
      defaultTypeName: "not-there",
      warn: () => {},
    });
    expect(() => registry.getManifest("fixture-or-anything")).toThrow(
      /SHIPWRIGHT_SPECIALTIES_DIR.*SHIPWRIGHT_DEFAULT_AGENT_TYPE/s,
    );
  });
});
