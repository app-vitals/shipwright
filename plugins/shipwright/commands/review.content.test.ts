import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REVIEW_MD_PATH = join(import.meta.dir, "review.md");

let content: string;

beforeAll(() => {
  content = readFileSync(REVIEW_MD_PATH, "utf-8");
});

describe("review.md — pre-claim marker documentation (CBD-1.4)", () => {
  it("Arguments section documents the [preclaim:{recordId}:{commitSha}] marker format", () => {
    const argsIdx = content.indexOf("## Arguments");
    const step1Idx = content.indexOf("## Step 1: Load Policy");
    expect(argsIdx).toBeGreaterThan(-1);
    expect(step1Idx).toBeGreaterThan(-1);
    const argsSection = content.slice(argsIdx, step1Idx);

    expect(argsSection).toContain("[preclaim:{recordId}:{commitSha}]");
    expect(argsSection).toContain("CBD-1.3");
  });

  it("Arguments section attributes the marker to the loop orchestrator, not a human caller", () => {
    const argsIdx = content.indexOf("## Arguments");
    const step1Idx = content.indexOf("## Step 1: Load Policy");
    const argsSection = content.slice(argsIdx, step1Idx);

    expect(argsSection).toContain("loop orchestrator");
    expect(argsSection.toLowerCase()).toContain("human");
  });
});

describe("review.md — pre-claim fast path skips re-claiming (CBD-1.4)", () => {
  it("Step 14 has a Pre-Claim Fast Path section", () => {
    const sectionIdx = content.indexOf("### Pre-Claim Fast Path (CBD-1.4)");
    expect(sectionIdx).toBeGreaterThan(-1);
  });

  it("Pre-Claim Fast Path validates the marker's commitSha against the live headRefOid", () => {
    const sectionIdx = content.indexOf("### Pre-Claim Fast Path (CBD-1.4)");
    const nextSectionIdx = content.indexOf("2. Fetch the PR record from the task store:", sectionIdx);
    expect(sectionIdx).toBeGreaterThan(-1);
    expect(nextSectionIdx).toBeGreaterThan(-1);
    const section = content.slice(sectionIdx, nextSectionIdx);

    expect(section).toContain("headRefOid");
    expect(section).toContain("PRECLAIM_COMMIT_SHA");
  });

  it("Pre-Claim Fast Path trusts a matching marker and sets PR_RECORD_ID directly", () => {
    const sectionIdx = content.indexOf("### Pre-Claim Fast Path (CBD-1.4)");
    const nextSectionIdx = content.indexOf("2. Fetch the PR record from the task store:", sectionIdx);
    const section = content.slice(sectionIdx, nextSectionIdx);

    expect(section).toContain("headRefOid == PRECLAIM_COMMIT_SHA");
    expect(section).toContain("PR_RECORD_ID = PRECLAIM_RECORD_ID");
    expect(section).toContain("skip");
  });

  it("Pre-Claim Fast Path falls back to self-claiming on a stale or absent marker", () => {
    const sectionIdx = content.indexOf("### Pre-Claim Fast Path (CBD-1.4)");
    const nextSectionIdx = content.indexOf("2. Fetch the PR record from the task store:", sectionIdx);
    const section = content.slice(sectionIdx, nextSectionIdx);

    expect(section).toContain("headRefOid != PRECLAIM_COMMIT_SHA");
    expect(section).toContain("no marker present");
    expect(section).toContain("self-claiming exactly as today");
  });

  it("Step 4's claim subsection skips its own /prs/claim call when PR_RECORD_ID was already set by the fast path", () => {
    const sectionIdx = content.indexOf("### Claim using pre-captured commit SHA");
    const nextSectionIdx = content.indexOf("## Step 5: Gather Context");
    expect(sectionIdx).toBeGreaterThan(-1);
    expect(nextSectionIdx).toBeGreaterThan(-1);
    const section = content.slice(sectionIdx, nextSectionIdx);

    expect(section).toContain("Skip this subsection if `PR_RECORD_ID` was already set");
    expect(section).toContain("CBD-1.4");
    expect(section).toContain("/prs/claim");
  });

  it("Step 1 of Step 14 parses and strips the pre-claim marker before parsing org/repo/pr", () => {
    const step14Idx = content.indexOf("## Step 14: Resolve and Claim the Target PR");
    const fastPathIdx = content.indexOf("### Pre-Claim Fast Path (CBD-1.4)");
    expect(step14Idx).toBeGreaterThan(-1);
    expect(fastPathIdx).toBeGreaterThan(-1);
    const section = content.slice(step14Idx, fastPathIdx);

    expect(section).toContain("PRECLAIM_RECORD_ID");
    expect(section).toContain("PRECLAIM_COMMIT_SHA");
    expect(section).toContain("strip the marker");
  });
});
