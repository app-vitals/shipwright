/**
 * principles.md wiring tests — PRN-2.3
 *
 * Verifies plan-session.md and dev-task.md each reference the shared
 * references/principles.md file — net-new wiring so generated tasks (plan-session)
 * and execution guidance (dev-task) reflect the architecture/testing principles
 * defined there.
 *
 * Content-assertion only: existsSync/readFileSync, no I/O beyond local file
 * reads (mirrors principles-content.unit.test.ts).
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// plugins/shipwright/commands/ → plugins/shipwright/
const pluginRoot = resolve(import.meta.dir, "..");

function pluginPath(...parts: string[]): string {
  return join(pluginRoot, ...parts);
}

const planSessionPath = pluginPath("commands", "plan-session.md");
const devTaskPath = pluginPath("commands", "dev-task.md");

function readPlanSession(): string {
  return readFileSync(planSessionPath, "utf8");
}

function readDevTask(): string {
  return readFileSync(devTaskPath, "utf8");
}

describe("principles.md wiring — files exist", () => {
  it("commands/plan-session.md exists", () => {
    expect(existsSync(planSessionPath)).toBe(true);
  });

  it("commands/dev-task.md exists", () => {
    expect(existsSync(devTaskPath)).toBe(true);
  });
});

describe("plan-session.md — references principles.md", () => {
  it("mentions references/principles.md", () => {
    expect(readPlanSession()).toContain("references/principles.md");
  });

  it("references principles.md near task generation guidance (Step 5: Task Breakdown)", () => {
    const content = readPlanSession();
    const stepIndex = content.indexOf("## Step 5: Task Breakdown");
    const nextStepIndex = content.indexOf("## Step 5.5: HITL Detection");
    expect(stepIndex).toBeGreaterThan(-1);
    expect(nextStepIndex).toBeGreaterThan(stepIndex);
    const stepSection = content.slice(stepIndex, nextStepIndex);
    expect(stepSection).toContain("references/principles.md");
  });
});

describe("dev-task.md — references principles.md", () => {
  it("mentions references/principles.md", () => {
    expect(readDevTask()).toContain("references/principles.md");
  });

  it("references principles.md near execution guidance (PROJECT CONVENTIONS / implementation steps)", () => {
    const content = readDevTask();
    const briefIndex = content.indexOf("PROJECT CONVENTIONS (from CLAUDE.md):");
    const ciGateIndex = content.indexOf("## Step 9b: CI Gate");
    expect(briefIndex).toBeGreaterThan(-1);
    expect(ciGateIndex).toBeGreaterThan(briefIndex);
    const executionSection = content.slice(briefIndex, ciGateIndex);
    expect(executionSection).toContain("references/principles.md");
  });
});
