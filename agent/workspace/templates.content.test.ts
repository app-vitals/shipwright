/**
 * agent/workspace/templates.content.test.ts
 * Content-layer tests for the coding workspace template set Shipwright owns
 * (CET-1.3). The coding specialty's identity.templatesDir is agent/workspace/
 * (the platform resolves it relative to SHIPWRIGHT_REPO_ROOT); this guards the
 * set and the image copy now that the coding manifest is gone (CET-4.2).
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const templatesDir = import.meta.dir;

// The platform's REQUIRED_TEMPLATES (runtime/setup.ts) plus the coding-owned
// optional ones: SPECIALTY (pipeline text) and BOOTSTRAP (dev-loop ritual).
const REQUIRED = [
  "CLAUDE.md.template",
  "SOUL.md.template",
  "IDENTITY.md.template",
];
const CODING_OWNED = ["SPECIALTY.md.template", "BOOTSTRAP.md.template"];

describe("agent/workspace — coding template set", () => {
  it.each([...REQUIRED, ...CODING_OWNED, "CLAUDE-HITL.md.template"])(
    "provides a non-empty %s",
    (name) => {
      const path = join(templatesDir, name);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf-8").trim().length).toBeGreaterThan(0);
    },
  );

  it("SPECIALTY.md.template carries the full shipwright pipeline text", () => {
    const body = readFileSync(
      join(templatesDir, "SPECIALTY.md.template"),
      "utf-8",
    );
    for (const needle of [
      "/shipwright:plan-session",
      "/shipwright:dev-task",
      "/shipwright:review",
      "shipwright-loop",
      "SHIPWRIGHT_TASK_STORE_URL",
    ]) {
      expect(body).toContain(needle);
    }
  });

  it("the agent Dockerfile ships the whole templates dir into the image", () => {
    const df = readFileSync(join(templatesDir, "..", "Dockerfile"), "utf-8");
    expect(df).toContain(
      "COPY --chown=1000:1000 agent/workspace ./agent/workspace",
    );
  });
});
