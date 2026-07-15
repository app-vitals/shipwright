import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REVIEW_PATCH_MD_PATH = join(import.meta.dir, "review-patch.md");

let content: string;

beforeAll(() => {
  content = readFileSync(REVIEW_PATCH_MD_PATH, "utf-8");
});

describe("review-patch.md — precheck invocations", () => {
  it("references the check-patch precheck script", () => {
    expect(content).toContain("check-patch");
  });

  it("references the check-review precheck script", () => {
    expect(content).toContain("check-review");
  });

  it("runs check-patch as a bash command", () => {
    expect(content).toContain('bun "$CHECK_SCRIPTS/check-patch.ts"');
  });

  it("runs check-review as a bash command", () => {
    expect(content).toContain('bun "$CHECK_SCRIPTS/check-review.ts"');
  });
});

describe("review-patch.md — sub-agent spawning", () => {
  it("spawns /shipwright:patch as a sub-agent when check-patch exits 0", () => {
    expect(content).toContain("/shipwright:patch");
  });

  it("spawns /shipwright:review as a sub-agent when check-review exits 0", () => {
    expect(content).toContain("/shipwright:review");
  });

  it("uses the Agent tool to dispatch sub-agents", () => {
    expect(content).toContain("Agent");
  });
});

describe("review-patch.md — silent marker when nothing to do", () => {
  it("appends [silent] when neither precheck triggers on the first pass", () => {
    expect(content).toContain("[silent]");
  });
});

describe("review-patch.md — 25-minute timeout", () => {
  it("has a 25-minute elapsed budget", () => {
    expect(content).toContain("25");
  });

  it("prints a timeout notice when the budget is exceeded", () => {
    expect(content.toLowerCase()).toContain("timeout");
  });
});

describe("review-patch.md — loop exit condition", () => {
  it("loops until both prechecks return exit 1", () => {
    expect(content).toContain("exit 1");
  });

  it("breaks the loop when both prechecks return nothing to do", () => {
    expect(content.toLowerCase()).toContain("break");
  });
});

describe("review-patch.md — orchestrator shape (not a Workflow pipeline)", () => {
  it("does NOT use the Workflow tool", () => {
    expect(content).not.toContain("pipeline(");
  });

  it("records start time at the beginning", () => {
    expect(content.toLowerCase()).toContain("start time");
  });
});

describe("review-patch.md — plugin script depth resolution", () => {
  it("uses maxdepth 5 to find precheck scripts in the cache layout", () => {
    expect(content).toContain("maxdepth 5");
  });
});
