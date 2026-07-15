import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONTENT_PATH = join(import.meta.dir, "refresh-plan.md");
let content: string;

beforeAll(() => {
  content = readFileSync(CONTENT_PATH, "utf-8");
});

describe("refresh-plan.md — task store HTTP integration", () => {
  it("queries task store with session filter", () => {
    expect(content).toContain("session=");
  });

  it("uses HTTP API — no script discovery or task_store.ts", () => {
    expect(content).not.toContain("task_store.ts");
    expect(content).not.toContain("PLUGIN_SCRIPTS");
  });

  it("uses ready=true for available tasks listing", () => {
    expect(content).toContain("ready=true");
  });

  it("documents fallback to Appendix parsing when task store is empty", () => {
    const lower = content.toLowerCase();
    const hasFallback =
      lower.includes("fallback") || lower.includes("fall back");
    expect(hasFallback).toBe(true);
  });

  it("Step 2 uses task store status=pending to identify stale tasks", () => {
    const hasPendingFromStore =
      content.includes("status=pending") ||
      content.includes("status: pending") ||
      (content.includes("pending") &&
        content.includes("SHIPWRIGHT_TASK_STORE_URL"));
    expect(hasPendingFromStore).toBe(true);
  });

  it("Step 3B checks dependency status from task store data", () => {
    const hasDepsFromStore =
      content.includes("SHIPWRIGHT_TASK_STORE_URL") &&
      (content.includes("dependency") || content.includes("dep"));
    expect(hasDepsFromStore).toBe(true);
  });
});
