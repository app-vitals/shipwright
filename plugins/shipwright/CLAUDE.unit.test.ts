import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLAUDE_MD_PATH = join(import.meta.dir, "CLAUDE.md");

let content: string;

beforeAll(() => {
  content = readFileSync(CLAUDE_MD_PATH, "utf-8");
});

describe("CLAUDE.md — file exists and has content", () => {
  it("is readable and non-empty", () => {
    expect(content.length).toBeGreaterThan(100);
  });

  it("contains a design constitution header or introduction", () => {
    const hasHeader =
      content.includes("design constitution") ||
      content.includes("Design Constitution") ||
      content.includes("independence") ||
      content.includes("Independence");
    expect(hasHeader).toBe(true);
  });
});

describe("CLAUDE.md — Independence Principles section", () => {
  it("has an Independence Principles section heading", () => {
    const hasSection =
      content.includes("Independence Principles") ||
      content.includes("independence principles");
    expect(hasSection).toBe(true);
  });

  it("documents principle: GitHub as source of truth", () => {
    const hasGitHub =
      (content.toLowerCase().includes("github") &&
        content.toLowerCase().includes("source of truth")) ||
      content.includes("GitHub as source of truth") ||
      content.includes("GitHub is the source of truth");
    expect(hasGitHub).toBe(true);
  });

  it("documents principle: state files are caches not prerequisites", () => {
    const hasCachePrinciple =
      (content.includes("reviews.json") ||
        content.includes("todos.json") ||
        content.includes("state files")) &&
      (content.includes("cache") || content.includes("caches"));
    expect(hasCachePrinciple).toBe(true);
  });

  it("documents principle: PR created outside shipwright is fully serviceable", () => {
    const hasExternalPrPrinciple =
      content.includes("outside shipwright") ||
      content.includes("outside Shipwright") ||
      content.includes("created externally") ||
      (content.includes("PR") &&
        content.includes("serviceable") &&
        (content.includes("review") ||
          content.includes("patch") ||
          content.includes("deploy")));
    expect(hasExternalPrPrinciple).toBe(true);
  });

  it("documents principle: manual human actions do not break automation", () => {
    const hasManualPrinciple =
      (content.includes("manual") || content.includes("human")) &&
      (content.includes("break") ||
        content.includes("automation") ||
        content.includes("current state"));
    expect(hasManualPrinciple).toBe(true);
  });

  it("documents principle: no skill depends on another having run first", () => {
    const hasNoDependencyPrinciple =
      content.includes("no skill depends") ||
      content.includes("not depend on another") ||
      content.includes("depends on another") ||
      (content.includes("skill") && content.includes("run first")) ||
      content.includes("having run first");
    expect(hasNoDependencyPrinciple).toBe(true);
  });

  it("documents principle: skills are idempotent", () => {
    const hasIdempotentPrinciple = content.includes("idempotent");
    expect(hasIdempotentPrinciple).toBe(true);
  });
});

describe("CLAUDE.md — Candidate Selection Contract section", () => {
  it("has a Candidate Selection Contract section", () => {
    const hasSection =
      content.includes("Candidate Selection Contract") ||
      content.includes("candidate selection contract");
    expect(hasSection).toBe(true);
  });

  it("states that agent/src candidate providers are authoritative on what qualifies", () => {
    const hasAuthoritative =
      content.includes("authoritative") && content.includes("agent/src");
    expect(hasAuthoritative).toBe(true);
  });

  it("states the command re-validates current-state safety, not requalification", () => {
    const hasRevalidation =
      content.includes("current-state safety") ||
      content.includes("re-validates current-state");
    expect(hasRevalidation).toBe(true);
  });

  it("states that when a candidate provider's qualification logic changes the corresponding command should be reviewed", () => {
    const hasReviewRequirement =
      (content.includes("qualification") || content.includes("qualifying")) &&
      content.includes("should be reviewed");
    expect(hasReviewRequirement).toBe(true);
  });
});

describe("CLAUDE.md — skills listed in context of principles", () => {
  it("mentions review skill in context of principles", () => {
    expect(content).toContain("review");
  });

  it("mentions deploy skill in context of principles", () => {
    expect(content).toContain("deploy");
  });

  it("mentions dev-task skill in context of principles", () => {
    const hasDevTask =
      content.includes("dev-task") || content.includes("dev_task");
    expect(hasDevTask).toBe(true);
  });

  it("mentions patch skill in context of principles", () => {
    expect(content).toContain("patch");
  });

  it("mentions candidate provider scripts by name", () => {
    const hasScripts =
      content.includes("check-review") ||
      content.includes("check-deploy") ||
      content.includes("check-dev-task") ||
      content.includes("check-patch");
    expect(hasScripts).toBe(true);
  });
});
