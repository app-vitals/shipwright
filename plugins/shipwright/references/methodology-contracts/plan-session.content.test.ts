import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REFERENCE_PATH = join(import.meta.dir, "plan-session.md");

let content: string;

beforeAll(() => {
  if (existsSync(REFERENCE_PATH)) {
    content = readFileSync(REFERENCE_PATH, "utf-8");
  } else {
    content = "";
  }
});

describe("plan-session.md — file exists and has content", () => {
  it("file exists", () => {
    expect(existsSync(REFERENCE_PATH)).toBe(true);
  });

  it("is non-empty", () => {
    expect(content.length).toBeGreaterThan(200);
  });
});

describe("plan-session.md — framed as an implementation-agnostic interface contract", () => {
  it("frames the contract as applying to any plan-session-phase subagent, not just the built-in implementation", () => {
    expect(content.toLowerCase()).toMatch(
      /any (?:subagent plugged into the "plan-session"|plan-session-phase subagent)|custom subagent/,
    );
  });

  it("references commands/plan-session.md as the reference implementation", () => {
    expect(content).toContain("commands/plan-session.md");
  });

  it("names the plan-session AgentPhaseMethodology phase value", () => {
    expect(content).toContain('"plan-session"');
  });
});

describe("plan-session.md — inputs", () => {
  it("documents the PRODUCT-SPEC.md content input", () => {
    expect(content).toContain("specContent");
    expect(content).toContain("PRODUCT-SPEC.md");
  });

  it("documents repo and session inputs", () => {
    expect(content).toContain("`repo`");
    expect(content).toContain("`session`");
  });

  it("documents the existing-session-tasks dedup input", () => {
    expect(content).toContain("existingSessionTaskIds");
  });

  it("documents the open-cross-session-tasks input", () => {
    expect(content).toContain("openCrossSessionTasks");
  });

  it("documents the optional test layer definitions input with its fallback", () => {
    expect(content).toContain("testLayerDefs");
    expect(content).toContain("test-system.md");
  });

  it("documents the optional principles input", () => {
    expect(content).toContain("principles");
    expect(content).toContain("principles.md");
  });

  it("documents the autonomous mode input and its ambiguity bar", () => {
    expect(content).toContain("autonomous");
    expect(content.toLowerCase()).toContain("soft ambiguity");
    expect(content.toLowerCase()).toContain("hard contradiction");
  });
});

describe("plan-session.md — output", () => {
  it("documents the tasks[] array", () => {
    expect(content).toContain("tasks[]");
  });

  it("cross-references the bulk-POST task-store schema", () => {
    expect(content).toContain("task-store/prisma/schema.prisma");
    expect(content).toContain("BulkInsertItemSchema");
  });

  it("documents every bulk-POST task field", () => {
    for (const field of [
      "id",
      "source",
      "session",
      "repo",
      "title",
      "description",
      "acceptanceCriteria",
      "layer",
      "branch",
      "dependencies",
      "status",
      "hitl",
      "pr",
      "hours",
      "complexity",
      "model",
    ]) {
      expect(content).toContain(`\`${field}\``);
    }
  });

  it("documents planMarkdown and that the caller (not the subagent) writes PLAN.md", () => {
    expect(content).toContain("planMarkdown");
    expect(content).toContain("PLAN.md");
  });

  it("documents decisionLog[]", () => {
    expect(content).toContain("decisionLog");
  });

  it("documents hardContradiction and its null-on-success contract", () => {
    expect(content).toContain("hardContradiction");
    expect(content).toContain("null");
  });
});

describe("plan-session.md — scope", () => {
  it("clarifies the subagent does not touch the task store, filesystem, or GitHub directly", () => {
    expect(content.toLowerCase()).toContain("task store");
    expect(content.toLowerCase()).toMatch(
      /does not touch the task store, the filesystem, or github/,
    );
  });

  it("clarifies the wrapper owns writing PLAN.md, the bulk POST, and the plan PR", () => {
    expect(content).toContain("/tasks/bulk");
    expect(content.toLowerCase()).toContain("plan pr");
  });
});
