import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEPLOY_MD_PATH = join(import.meta.dir, "deploy.md");

let content: string;

beforeAll(() => {
  content = readFileSync(DEPLOY_MD_PATH, "utf-8");
});

describe("deploy.md — own-PRs-only check (AC1 & AC2)", () => {
  it("contains own GH login check (AGENT_LOGIN or 'own GH login')", () => {
    const hasAgentLogin = content.includes("AGENT_LOGIN");
    const hasOwnGhLogin = content.includes("own GH login");
    expect(hasAgentLogin || hasOwnGhLogin).toBe(true);
  });

  it("contains PR_AUTHOR check to identify who authored the PR", () => {
    expect(content).toContain("PR_AUTHOR");
  });

  it("states that PRs authored by others are skipped silently", () => {
    const hasSkipSilently =
      content.includes("skip it silently") || content.includes("skip silently");
    expect(hasSkipSilently).toBe(true);
  });
});

describe("deploy.md — no-pipeline detection (AC3 & AC4)", () => {
  it("polls for Deploy workflow for up to 5 minutes after merge", () => {
    // Must mention 5 minutes in the context of no-pipeline detection
    const has5MinPoll =
      content.includes("5 minutes") || content.includes("5-minute");
    expect(has5MinPoll).toBe(true);
  });

  it("prints 'No Deploy workflow' message when no pipeline fires", () => {
    expect(content).toContain("No Deploy workflow");
  });

  it("marks task deployed and exits cleanly when no pipeline fires", () => {
    const hasNoPipelineExit =
      content.includes("no_pipeline") ||
      content.includes("no pipeline") ||
      content.includes("no deploy pipeline");
    expect(hasNoPipelineExit).toBe(true);
  });
});

describe("deploy.md — full 30-minute watch (AC5)", () => {
  it("still runs the full 30-minute pipeline watch when Deploy workflow IS detected", () => {
    const has30Min =
      content.includes("30-minute") ||
      content.includes("30 minutes") ||
      content.includes("Budget: 30 minutes");
    expect(has30Min).toBe(true);
  });
});
