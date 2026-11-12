import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_ROOT = join(import.meta.dir, "..");
const REFERENCE_PATH = join(import.meta.dir, "coding-cron-guidance.md");
const content = existsSync(REFERENCE_PATH) ? readFileSync(REFERENCE_PATH, "utf-8") : "";

describe("coding-cron-guidance.md", () => {
  it("exists and has content", () => {
    expect(existsSync(REFERENCE_PATH)).toBe(true);
    expect(content.length).toBeGreaterThan(200);
  });

  it("points at the coding specialty defaults", () => {
    expect(content).toContain("admin/src/coding/coding-specialty-defaults.ts");
  });

  it("gives shipwright:check-* preCheck examples that resolve to real scripts", () => {
    const refs = [...content.matchAll(/shipwright:(check-[a-z-]+\.ts)/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const script of refs) {
      expect(existsSync(join(PLUGIN_ROOT, "scripts", script))).toBe(true);
    }
  });
});

describe("removed skills (APP-4.1)", () => {
  const readme = readFileSync(join(PLUGIN_ROOT, "README.md"), "utf-8");

  it.each(["agent-admin", "slack-say"])("README does not list the %s skill", (skill) => {
    expect(readme).not.toContain(`${skill}/`);
    expect(readme).not.toContain(`shipwright:${skill}`);
  });

  it.each(["agent-admin", "slack-say"])("plugin no longer ships skills/%s", (skill) => {
    expect(existsSync(join(PLUGIN_ROOT, "skills", skill))).toBe(false);
  });

  it("no longer ships scripts/slack-say.ts", () => {
    expect(existsSync(join(PLUGIN_ROOT, "scripts", "slack-say.ts"))).toBe(false);
  });
});

describe("docs/platform/chat-service.md Thread fields", () => {
  const chatDoc = readFileSync(join(PLUGIN_ROOT, "../../docs/platform/chat-service.md"), "utf-8");

  it.each(["kind", "askFromAgentId", "askDepth"])("documents %s as admin-only", (field) => {
    const row = chatDoc.split("\n").find((l) => l.startsWith(`| \`${field}\``));
    expect(row).toBeDefined();
    expect(row).toContain("Admin-only");
  });
});
