import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REFERENCE_PATH = join(import.meta.dir, "patch.md");

let content: string;

beforeAll(() => {
  if (existsSync(REFERENCE_PATH)) {
    content = readFileSync(REFERENCE_PATH, "utf-8");
  } else {
    content = "";
  }
});

describe("patch.md — file exists and has content", () => {
  it("file exists", () => {
    expect(existsSync(REFERENCE_PATH)).toBe(true);
  });

  it("is non-empty", () => {
    expect(content.length).toBeGreaterThan(200);
  });
});

describe("patch.md — framed as an implementation-agnostic interface contract", () => {
  it("frames the contract as applying to any patch-phase subagent, not just the built-in implementation", () => {
    expect(content.toLowerCase()).toMatch(/any (?:patch-phase )?subagent|custom subagent/);
  });

  it("references commands/patch.md as the reference implementation", () => {
    expect(content).toContain("commands/patch.md");
  });

  it("references the AgentPhaseMethodology override", () => {
    expect(content).toContain("AgentPhaseMethodology");
  });
});

describe("patch.md — inputs", () => {
  it("documents an Inputs section", () => {
    expect(content).toContain("## Inputs");
  });

  it("documents PR metadata fields", () => {
    expect(content).toContain("repo");
    expect(content).toContain("number");
    expect(content).toContain("title");
    expect(content).toContain("headRefName");
    expect(content).toContain("headRefOid");
  });

  it("documents unresolved findings input, grounded in review threads", () => {
    expect(content.toLowerCase()).toContain("unresolved findings");
    expect(content).toContain("reviewThreads");
  });

  it("documents the dependency-risk finding shape", () => {
    expect(content).toContain("DEPENDENCY_RISK_FINDING");
    expect(content).toContain("recommendation");
    expect(content).toContain("flags");
    expect(content).toContain("reasoning");
    expect(content).toContain("dependency-risk-analysis.md");
  });

  it("documents mergeability state, grounded in mergeStateStatus", () => {
    expect(content.toLowerCase()).toContain("mergeability");
    expect(content).toContain("mergeStateStatus");
    expect(content).toContain("DIRTY");
  });

  it("documents CI status input", () => {
    expect(content.toLowerCase()).toContain("ci status");
    expect(content.toLowerCase()).toMatch(/job name|failed step/);
  });

  it("explains that a single dispatch only carries the list(s) that qualified", () => {
    expect(content).toContain("List A");
    expect(content).toContain("List C");
    expect(content).toContain("List D");
    expect(content.toLowerCase()).toMatch(/not every dispatch|only reflects the list/);
  });
});

describe("patch.md — output", () => {
  it("documents an Output section", () => {
    expect(content).toContain("## Output");
  });

  it("documents the STATUS verdict values", () => {
    expect(content).toContain("DONE_WITH_CONCERNS");
    expect(content).toContain("BLOCKED");
    expect(content).toContain("status");
  });

  it("documents fix actions taken and concerns fields", () => {
    expect(content.toLowerCase()).toContain("fix actions taken");
    expect(content).toContain("concerns");
  });

  it("documents blocker as the escalate-to-HITL decision", () => {
    expect(content).toContain("blocker");
    expect(content.toLowerCase()).toContain("escalate-to-hitl");
  });

  it("clarifies the subagent does not itself perform the escalation", () => {
    expect(content.toLowerCase()).toMatch(/does not (perform|do) the (actual )?escalation/);
    expect(content).toContain("escalation-pattern.md");
  });
});

describe("patch.md — scope", () => {
  it("documents a Scope section", () => {
    expect(content).toContain("## Scope");
  });

  it("clarifies the caller owns PR resolution and classification into Lists A/C/D", () => {
    expect(content.toLowerCase()).toContain("classification");
    expect(content).toContain("List A");
  });

  it("clarifies the commit-bump handback to the PR record is caller-owned", () => {
    expect(content).toContain("/prs/");
    expect(content).toContain("commitSha");
    expect(content.toLowerCase()).toContain("caller-owned");
  });
});
