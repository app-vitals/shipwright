/**
 * platform-manifest.unit.test.ts
 *
 * Copy-paste-readiness gate (AEP-4.1), run against the real repo: walks the
 * import closure of the platform set listed in platform-manifest.json and fails
 * on any edge that leaves it. The exemption list must stay empty. The walker
 * itself is unit-tested with a fixture tree in scripts/platform-gate.unit.test.ts.
 *
 * See docs/platform-manifest.md for how to extend the manifest.
 */

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  analyzeClosure,
  checkLibTags,
  collectSetFiles,
  formatViolation,
  loadManifest,
  validateManifest,
} from "./scripts/platform-gate.ts";

const ROOT = resolve(import.meta.dir);
const manifest = loadManifest(join(ROOT, "platform-manifest.json"));

describe("platform manifest (copy-paste-readiness gate)", () => {
  it("is well-formed and its exemption list is empty", () => {
    expect(validateManifest(manifest)).toEqual([]);
    expect(manifest.exemptions).toEqual([]);
  });

  it("every include glob matches files and the pinned entries exist", () => {
    for (const pattern of manifest.include) {
      const matches = [...new Bun.Glob(pattern).scanSync({ cwd: ROOT })];
      expect(
        matches.length,
        `include matches nothing: ${pattern}`,
      ).toBeGreaterThan(0);
    }
    for (const root of manifest.compositionRoots) {
      expect(existsSync(join(ROOT, root.path)), `missing: ${root.path}`).toBe(
        true,
      );
    }
    const files = collectSetFiles(ROOT, manifest);
    for (const required of [
      "agent/Dockerfile",
      "admin/Dockerfile",
      "agent/src/entrypoint-main.ts",
      "agent/workspace/RUNTIME.md.template",
      "agent-types/specialist/manifest.yaml",
      "docs/schemas/agent-type.schema.json",
    ]) {
      expect(files, `set is missing ${required}`).toContain(required);
    }
    expect(files.some((f) => f.startsWith("admin/src/coding/"))).toBe(false);
    expect(files.some((f) => f.startsWith("agent/src/coding/"))).toBe(false);
  });

  it("no import edge leaves the platform set", () => {
    const { violations } = analyzeClosure(ROOT, manifest);
    expect(violations.map(formatViolation)).toEqual([]);
  });

  it("lib tags match who actually imports each module", () => {
    expect(checkLibTags(ROOT, manifest)).toEqual([]);
  });
});
