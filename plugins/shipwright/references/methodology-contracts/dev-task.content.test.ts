import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REFERENCE_PATH = join(import.meta.dir, "dev-task.md");

let content: string;

beforeAll(() => {
  if (existsSync(REFERENCE_PATH)) {
    content = readFileSync(REFERENCE_PATH, "utf-8");
  } else {
    content = "";
  }
});

describe("dev-task.md — file exists and has content", () => {
  it("file exists", () => {
    expect(existsSync(REFERENCE_PATH)).toBe(true);
  });

  it("is non-empty", () => {
    expect(content.length).toBeGreaterThan(200);
  });
});

describe("dev-task.md — framed as an implementation-agnostic interface contract", () => {
  it("frames the contract as applying to any dev-task-phase subagent, not just the built-in implementation", () => {
    expect(content.toLowerCase()).toMatch(/any (?:dev-task-phase )?subagent|custom subagent/);
  });

  it("references commands/dev-task.md as the reference implementation", () => {
    expect(content).toContain("commands/dev-task.md");
  });

  it("references the AgentPhaseMethodology override with the dev-task phase value", () => {
    expect(content).toContain("AgentPhaseMethodology");
    expect(content).toContain('"dev-task"');
  });

  it("frames the swap as Step-5-only", () => {
    expect(content.toLowerCase()).toContain("step-5-only");
  });
});

describe("dev-task.md — inputs", () => {
  it("documents an Inputs section", () => {
    expect(content).toContain("## Inputs");
  });

  it("documents the Implementation Brief task fields", () => {
    expect(content.toLowerCase()).toContain("implementation brief");
    expect(content).toContain("title");
    expect(content).toContain("description");
    expect(content).toContain("acceptanceCriteria");
    expect(content).toContain("layer");
  });

  it("documents the worktree-path input and that the subagent does not create a new branch", () => {
    expect(content).toContain("worktree-path");
    expect(content.toLowerCase()).toContain("does not");
    expect(content.toLowerCase()).toContain("new branch");
  });

  it("documents CLAUDE.md contents as an input", () => {
    expect(content).toContain("CLAUDE.md");
  });

  it("documents the resolved toolchain commands input", () => {
    expect(content.toLowerCase()).toContain("toolchain");
    expect(content.toLowerCase()).toContain("validate command");
    expect(content.toLowerCase()).toContain("typecheck command");
  });

  it("documents the TDD requirement as non-negotiable", () => {
    expect(content.toLowerCase()).toContain("red-green-refactor");
    expect(content.toLowerCase()).toContain("required");
  });
});

describe("dev-task.md — output", () => {
  it("documents an Output section", () => {
    expect(content).toContain("## Output");
  });

  it("documents the STATUS verdict values", () => {
    expect(content).toContain("DONE_WITH_CONCERNS");
    expect(content).toContain("NEEDS_CONTEXT");
    expect(content).toContain("BLOCKED");
    expect(content).toContain("status");
  });

  it("documents the dual output — text report plus committed code changes", () => {
    expect(content.toLowerCase()).toContain("dual");
    expect(content).toContain("git diff main...HEAD");
    expect(content.toLowerCase()).toContain("committed");
  });

  it("documents concerns and blocker fields", () => {
    expect(content).toContain("concerns");
    expect(content).toContain("blocker");
  });

  it("documents blocker as the escalate-to-HITL decision handled by the caller's model-escalation ladder", () => {
    expect(content.toLowerCase()).toContain("escalate-to-hitl");
    expect(content.toLowerCase()).toContain("model-escalation ladder");
    expect(content).toContain("haiku");
    expect(content).toContain("sonnet");
    expect(content).toContain("opus");
  });
});

describe("dev-task.md — scope", () => {
  it("documents a Scope section", () => {
    expect(content).toContain("## Scope");
  });

  it("explicitly states Steps 6/6.5/8.5/9b are unconditional and out of scope for this swap", () => {
    expect(content).toContain(
      "Steps 6, 6.5, 8.5, and 9b are unconditional and out of scope for this swap",
    );
    expect(content.toLowerCase()).toContain("regardless of which subagent produced the code");
  });

  it("names each of the four unconditional steps by function", () => {
    expect(content.toLowerCase()).toContain("simplify");
    expect(content.toLowerCase()).toContain("spec compliance check");
    expect(content).toContain("docs-refresher");
    expect(content.toLowerCase()).toContain("ci gate");
  });

  it("clarifies branch creation, PR creation, and task-store status transitions stay caller-owned", () => {
    expect(content.toLowerCase()).toContain("branch naming, pr creation");
    expect(content).toContain("Steps 1/2/4/9/10a");
  });

  it("clarifies worktree setup and toolchain detection are caller-owned, not the subagent's", () => {
    expect(content.toLowerCase()).toContain("worktree setup and toolchain detection");
  });
});
