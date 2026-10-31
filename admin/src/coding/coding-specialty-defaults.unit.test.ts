/**
 * admin/src/coding/coding-specialty-defaults.unit.test.ts
 * Golden parity between the coding extension's specialtyDefaults() hook and
 * specialties/coding/manifest.yaml (CET-4.1). Retired with the manifest in
 * CET-4.2.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSpecialtyManifest } from "@app-vitals/agent-admin/specialty-registry";
import { codingAdminExtension } from "./coding-admin-extension.ts";
import {
  CODING_SPECIALTY_DEFAULTS,
  codingSpecialtyDefaults,
} from "./coding-specialty-defaults.ts";

const MANIFEST_PATH = join(
  import.meta.dir,
  "../../../specialties/coding/manifest.yaml",
);
const manifest = parseSpecialtyManifest(readFileSync(MANIFEST_PATH, "utf-8"));

describe("coding specialtyDefaults hook — parity with manifest.yaml", () => {
  const defaults = codingAdminExtension.specialtyDefaults?.("coding");

  it("is wired on the coding extension", () => {
    expect(defaults).toBe(CODING_SPECIALTY_DEFAULTS);
  });

  it("returns exactly the manifest's 14 crons, every field", () => {
    expect(defaults?.crons).toHaveLength(14);
    expect(defaults?.crons).toEqual(manifest.crons as never);
  });

  it("returns exactly the manifest's tools, in order", () => {
    expect(defaults?.tools).toHaveLength(11);
    expect(defaults?.tools).toEqual(manifest.tools);
  });

  it("returns exactly the manifest's plugins", () => {
    expect(defaults?.plugins).toEqual(manifest.plugins);
  });

  it("returns nothing for other specialties", () => {
    expect(codingSpecialtyDefaults("specialist")).toBeUndefined();
  });
});
