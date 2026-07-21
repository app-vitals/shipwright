import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLAUDE_MD_PATH = join(import.meta.dir, "CLAUDE.md");

let candidateSelectionSection: string;
let systemCronSection: string;

beforeAll(() => {
  const content = readFileSync(CLAUDE_MD_PATH, "utf-8");
  const candidateStart = content.indexOf("## Candidate Selection Contract");
  const systemCronStart = content.indexOf("## System Cron Changes");
  const envVarsStart = content.indexOf("## Environment Variables");
  candidateSelectionSection = content.slice(candidateStart, systemCronStart);
  systemCronSection = content.slice(systemCronStart, envVarsStart);
});

describe("CLAUDE.md — System Cron Changes is consistent with Candidate Selection Contract", () => {
  it("both sections are present", () => {
    expect(candidateSelectionSection).not.toBe("");
    expect(systemCronSection).not.toBe("");
  });

  it("System Cron Changes no longer describes review/patch as independent, self-discovering crons", () => {
    expect(systemCronSection).not.toContain(
      "review and patch run as independent phases",
    );
    expect(systemCronSection.toLowerCase()).not.toContain(
      "each runs its own phase directly",
    );
  });

  it("System Cron Changes names shipwright-loop as the sole dispatcher, matching the Candidate Selection Contract", () => {
    expect(candidateSelectionSection).toContain("shipwright-loop");
    expect(systemCronSection).toContain("shipwright-loop");
  });

  it("System Cron Changes reflects that dev-task, review, patch, and deploy are dispatched phases, not independent crons", () => {
    for (const phase of ["dev-task", "review", "patch", "deploy"]) {
      expect(systemCronSection).toContain(phase);
    }
  });
});
