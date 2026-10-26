import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const skill = readFileSync(join(import.meta.dir, "SKILL.md"), "utf8");
const chatDoc = readFileSync(join(ROOT, "docs/chat.md"), "utf8");
const chartValues = readFileSync(join(ROOT, "charts/shipwright/templates/admin-deployment.yaml"), "utf8");

// Feature flags the chart exposes for the ask, chat-credential and doc surfaces.
const chartFlags = [
  ...new Set(
    [...chartValues.matchAll(/name: (SHIPWRIGHT_(?:AGENT_ASK|CHAT_TOKEN_MINT|ADMIN_DOC)_[A-Z_]+)/g)].map((m) => m[1]),
  ),
];

describe("agent-admin SKILL.md", () => {
  it("finds the chart flags", () => {
    expect(chartFlags).toContain("SHIPWRIGHT_AGENT_ASK_ENABLED");
    expect(chartFlags).toContain("SHIPWRIGHT_CHAT_TOKEN_MINT_ENABLED");
    expect(chartFlags).toContain("SHIPWRIGHT_ADMIN_DOC_ENABLED");
  });

  it.each(chartFlags)("names chart flag %s", (flag) => {
    expect(skill).toContain(flag);
  });

  it("names the platform scopes", () => {
    expect(skill).toContain("platform.read");
    expect(skill).toContain("platform.ops");
  });
});

describe("docs/chat.md Thread fields", () => {
  it.each(["kind", "askFromAgentId", "askDepth"])("documents %s as admin-only", (field) => {
    const row = chatDoc.split("\n").find((l) => l.startsWith(`| \`${field}\``));
    expect(row).toBeDefined();
    expect(row).toContain("Admin-only");
  });
});
