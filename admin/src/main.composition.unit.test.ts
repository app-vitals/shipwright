import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { applyShipwrightDefaults, SHIPWRIGHT_SPECIALTIES_DIR } from "./main.ts";

// Shipwright's composition root wires the coding admin extension into the
// platform boot. This tests that composition, so it stays with main.ts (Shipwright's
// composition root, not part of the platform).
const entrySource = await Bun.file(join(import.meta.dir, "main.ts")).text();

describe("main.ts composition root (coding)", () => {
  it("composes the platform with the coding extension and nothing else", () => {
    expect(entrySource).toContain('from "@app-vitals/agent-admin/admin-boot"');
    expect(entrySource).toContain('from "./coding/coding-admin-extension.ts"');
    expect(entrySource).toContain("startAdmin(adminExtensions)");
    expect(entrySource).toContain(
      "export const adminExtensions: readonly AdminExtension[] = [\n  codingAdminExtension,\n];",
    );
  });
});

describe("applyShipwrightDefaults (AGR-4.2)", () => {
  it("points the platform at Shipwright's repo-root specialties", () => {
    expect(
      existsSync(join(SHIPWRIGHT_SPECIALTIES_DIR, "coding", "manifest.yaml")),
    ).toBe(true);
    const env: Record<string, string | undefined> = {};
    applyShipwrightDefaults(env);
    expect(env.SHIPWRIGHT_SPECIALTIES_DIR).toBe(SHIPWRIGHT_SPECIALTIES_DIR);
  });

  it("keeps an operator-set specialties dir", () => {
    const env: Record<string, string | undefined> = {
      SHIPWRIGHT_SPECIALTIES_DIR: "/custom/specialties",
    };
    applyShipwrightDefaults(env);
    expect(env.SHIPWRIGHT_SPECIALTIES_DIR).toBe("/custom/specialties");
  });

  it("defaults the default and self-serve agent types to coding", () => {
    const env: Record<string, string | undefined> = {};
    applyShipwrightDefaults(env);
    expect(env.SHIPWRIGHT_DEFAULT_AGENT_TYPE).toBe("coding");
    expect(env.SHIPWRIGHT_SELF_SERVE_AGENT_TYPE).toBe("coding");
  });

  it("keeps operator-set default and self-serve agent types", () => {
    const env: Record<string, string | undefined> = {
      SHIPWRIGHT_DEFAULT_AGENT_TYPE: "specialist",
      SHIPWRIGHT_SELF_SERVE_AGENT_TYPE: "specialist",
    };
    applyShipwrightDefaults(env);
    expect(env.SHIPWRIGHT_DEFAULT_AGENT_TYPE).toBe("specialist");
    expect(env.SHIPWRIGHT_SELF_SERVE_AGENT_TYPE).toBe("specialist");
  });

  it("runs before startAdmin() in the entrypoint", () => {
    expect(
      entrySource.indexOf("applyShipwrightDefaults(process.env);"),
    ).toBeLessThan(entrySource.indexOf("startAdmin(adminExtensions)"));
    expect(
      entrySource.indexOf("applyShipwrightDefaults(process.env);"),
    ).toBeGreaterThan(entrySource.indexOf("if (import.meta.main)"));
  });
});
