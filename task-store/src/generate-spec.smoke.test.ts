/**
 * task-store/src/generate-spec.smoke.test.ts
 * Smoke test: verify the task-store OpenAPI spec generator produces a valid
 * OpenAPI 3.1 document that covers all three route groups.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateTaskStoreSpec } from "./generate-spec.ts";

// The generator writes to task-store/openapi.json by default.
// import.meta.dir is task-store/src/, so "../openapi.json" = task-store/openapi.json.
const SPEC_PATH = resolve(import.meta.dir, "../openapi.json");

describe("generateTaskStoreSpec", () => {
  // Back up any existing spec file so we can restore it after each test.
  let backup: string | null = null;

  beforeEach(() => {
    if (existsSync(SPEC_PATH)) {
      backup = readFileSync(SPEC_PATH, "utf-8");
      unlinkSync(SPEC_PATH);
    }
  });

  afterEach(() => {
    if (backup !== null) {
      writeFileSync(SPEC_PATH, backup, "utf-8");
      backup = null;
    }
  });

  it("writes a valid OpenAPI 3.1 document", () => {
    generateTaskStoreSpec(SPEC_PATH);

    expect(existsSync(SPEC_PATH)).toBe(true);

    const raw = readFileSync(SPEC_PATH, "utf-8");
    const spec = JSON.parse(raw) as Record<string, unknown>;

    expect(spec.openapi).toBe("3.1.0");
  });

  it("includes /tasks paths", () => {
    generateTaskStoreSpec(SPEC_PATH);

    const raw = readFileSync(SPEC_PATH, "utf-8");
    const spec = JSON.parse(raw) as { paths: Record<string, unknown> };
    const paths = Object.keys(spec.paths ?? {});

    const taskPaths = paths.filter((p) => p.startsWith("/tasks"));
    expect(taskPaths.length).toBeGreaterThan(0);
  });

  it("includes /tokens paths", () => {
    generateTaskStoreSpec(SPEC_PATH);

    const raw = readFileSync(SPEC_PATH, "utf-8");
    const spec = JSON.parse(raw) as { paths: Record<string, unknown> };
    const paths = Object.keys(spec.paths ?? {});

    const tokenPaths = paths.filter((p) => p.startsWith("/tokens"));
    expect(tokenPaths.length).toBeGreaterThan(0);
  });

  it("includes /prs paths", () => {
    generateTaskStoreSpec(SPEC_PATH);

    const raw = readFileSync(SPEC_PATH, "utf-8");
    const spec = JSON.parse(raw) as { paths: Record<string, unknown> };
    const paths = Object.keys(spec.paths ?? {});

    const prPaths = paths.filter((p) => p.startsWith("/prs"));
    expect(prPaths.length).toBeGreaterThan(0);
  });
});
