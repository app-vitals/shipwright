import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONTENT_PATH = join(import.meta.dir, "refresh-plan.md");
let content: string;

beforeAll(() => {
  content = readFileSync(CONTENT_PATH, "utf-8");
});

describe("refresh-plan.md — task_store integration", () => {
  it("queries task_store.ts with --session flag", () => {
    expect(content).toContain("--session");
  });

  it("resolves PLUGIN_SCRIPTS path for task_store.ts", () => {
    expect(content).toContain("task_store.ts");
    expect(content).toContain("find ~/.claude/plugins");
  });

  it("uses query --ready for available tasks listing", () => {
    expect(content).toContain("query --ready");
  });

  it("documents fallback to Appendix parsing when task_store is empty", () => {
    const lower = content.toLowerCase();
    const hasFallback =
      lower.includes("fallback") || lower.includes("fall back");
    expect(hasFallback).toBe(true);
  });

  it("Step 2 uses task_store status=pending to identify stale tasks", () => {
    const hasPendingFromStore =
      content.includes("status=pending") ||
      content.includes("status: pending") ||
      (content.includes("pending") && content.includes("task_store"));
    expect(hasPendingFromStore).toBe(true);
  });

  it("Step 3B checks dependency status from task_store data", () => {
    const hasDepsFromStore =
      content.includes("task_store") &&
      (content.includes("dependency") || content.includes("dep"));
    expect(hasDepsFromStore).toBe(true);
  });
});
