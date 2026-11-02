/**
 * agent/scripts/sync-workspace-templates.unit.test.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COPIED_TEMPLATES, syncWorkspaceTemplates } from "./sync-workspace-templates.ts";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "sync-workspace-templates-"));
  const sourceDir = join(root, "agent-workspace");
  const destPkgDir = join(root, "installed-agent-runtime");
  const destDir = join(destPkgDir, "workspace");
  for (const dir of [sourceDir, destPkgDir, destDir]) {
    Bun.spawnSync(["mkdir", "-p", dir]);
  }
  for (const name of COPIED_TEMPLATES) {
    writeFileSync(join(sourceDir, name), `source content for ${name}`);
  }
  writeFileSync(join(destDir, "SOUL.md.template"), "unrelated, must survive");
  writeFileSync(join(destPkgDir, "package.json"), "{}");
  return { sourceDir, destPkgDir, destDir };
}

describe("syncWorkspaceTemplates", () => {
  test("copies every template from the source dir into the resolved package's workspace/", () => {
    const { sourceDir, destPkgDir, destDir } = makeFixture();
    const resolve = (specifier: string, _fromDir: string) => {
      expect(specifier).toBe("@app-vitals/agent-runtime/package.json");
      return join(destPkgDir, "package.json");
    };

    const copied = syncWorkspaceTemplates(resolve, destPkgDir, sourceDir);

    expect(copied.sort()).toEqual(
      COPIED_TEMPLATES.map((n) => join(destDir, n)).sort(),
    );
    for (const name of COPIED_TEMPLATES) {
      expect(readFileSync(join(destDir, name), "utf8")).toBe(
        `source content for ${name}`,
      );
    }
  });

  test("leaves unrelated files in the destination workspace/ untouched", () => {
    const { sourceDir, destPkgDir, destDir } = makeFixture();
    const resolve = () => join(destPkgDir, "package.json");

    syncWorkspaceTemplates(resolve, destPkgDir, sourceDir);

    expect(readFileSync(join(destDir, "SOUL.md.template"), "utf8")).toBe(
      "unrelated, must survive",
    );
  });

  test("propagates a resolution failure instead of swallowing it", () => {
    const resolve = (): string => {
      throw new Error("Cannot find package '@app-vitals/agent-runtime'");
    };

    expect(() => syncWorkspaceTemplates(resolve)).toThrow(
      "Cannot find package",
    );
  });
});
