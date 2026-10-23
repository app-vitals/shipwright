import { describe, expect, it } from "bun:test";
import { join } from "node:path";

// Shipwright's composition root wires the coding admin extension into the
// platform boot. This tests that composition, so it stays with main.ts and is
// listed under compositionRoots in platform-manifest.json (not extracted).
const entrySource = await Bun.file(join(import.meta.dir, "main.ts")).text();

describe("main.ts composition root (coding)", () => {
  it("composes the platform with the coding extension and nothing else", () => {
    expect(entrySource).toContain('from "./admin-boot.ts"');
    expect(entrySource).toContain('from "./coding/coding-admin-extension.ts"');
    expect(entrySource).toContain("startAdmin(adminExtensions)");
    expect(entrySource).toContain(
      "export const adminExtensions: readonly AdminExtension[] = [\n  codingAdminExtension,\n];",
    );
  });
});
