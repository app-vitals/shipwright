import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_MD_PATH = join(import.meta.dir, "SKILL.md");

let content: string;

beforeAll(() => {
  if (existsSync(SKILL_MD_PATH)) {
    content = readFileSync(SKILL_MD_PATH, "utf-8");
  } else {
    content = "";
  }
});

describe("SKILL.md — file exists and has content", () => {
  it("file exists", () => {
    expect(existsSync(SKILL_MD_PATH)).toBe(true);
  });

  it("is non-empty", () => {
    expect(content.length).toBeGreaterThan(200);
  });
});

describe("SKILL.md — frontmatter", () => {
  it("has frontmatter with name: investigate-cron", () => {
    expect(content).toContain("name: investigate-cron");
  });

  it("has frontmatter with a description field", () => {
    expect(content).toMatch(/^description:/m);
  });
});

describe("SKILL.md — session matching pattern", () => {
  it("mentions the [Cron job: pattern for matching sessions", () => {
    expect(content).toContain("[Cron job:");
  });
});

describe("SKILL.md — workspace path encoding", () => {
  it("mentions replacing / and . with - for encoding the workspace path", () => {
    // Must mention that both / and . become -
    const hasSeparator =
      content.includes("replace") ||
      content.includes("Replace") ||
      content.includes("sed") ||
      content.includes("tr");
    const hasDotEncoding =
      content.includes(". with -") ||
      content.includes("`.` →") ||
      content.includes("`.`") ||
      content.includes("and `.`") ||
      content.includes("/ and .") ||
      content.includes('"." with') ||
      content.includes("'.' with") ||
      content.includes("tr '/.'") ||
      content.includes("s/[/.]");
    expect(hasSeparator && hasDotEncoding).toBe(true);
  });

  it("shows or describes the encoding transformation for workspace path", () => {
    // Should describe the encoding: /data/agent/home/workspace → -data-agent-home-workspace
    const hasExample =
      content.includes("-data-agent-home-workspace") ||
      content.includes("~/.claude/projects/") ||
      (content.includes("encoded") && content.includes("workspace"));
    expect(hasExample).toBe(true);
  });
});

describe("SKILL.md — Step 1: transcript directory", () => {
  it("has a Step 1 section about finding the transcript directory", () => {
    const hasStep1 =
      content.includes("Step 1") ||
      content.includes("## 1.") ||
      (content.includes("transcript") && content.includes("directory"));
    expect(hasStep1).toBe(true);
  });

  it("references ~/.claude/projects/ as the transcript root", () => {
    expect(content).toContain("~/.claude/projects/");
  });
});

describe("SKILL.md — Step 2: time conversion / Pacific timezone", () => {
  it("has a Step 2 section about time conversion", () => {
    const hasStep2 =
      content.includes("Step 2") ||
      content.includes("## 2.") ||
      (content.includes("time") && content.includes("convert"));
    expect(hasStep2).toBe(true);
  });

  it("mentions Pacific timezone as the default", () => {
    const hasPacific =
      content.includes("Pacific") ||
      content.includes("America/Los_Angeles") ||
      content.includes("US/Pacific");
    expect(hasPacific).toBe(true);
  });
});

describe("SKILL.md — Step 3: searching JSONL files", () => {
  it("has a Step 3 section about searching JSONL files", () => {
    const hasStep3 =
      content.includes("Step 3") ||
      content.includes("## 3.") ||
      content.includes("## 3:");
    expect(hasStep3).toBe(true);
  });

  it("mentions JSONL files", () => {
    expect(content.includes("jsonl") || content.includes("JSONL")).toBe(true);
  });

  it("describes a time window for searching (mtime or ±90 or similar)", () => {
    const hasWindow =
      content.includes("90") ||
      content.includes("mtime") ||
      content.includes("window") ||
      content.includes("±");
    expect(hasWindow).toBe(true);
  });
});

describe("SKILL.md — Step 4: extracting what happened", () => {
  it("has a Step 4 section about extracting session content", () => {
    const hasStep4 =
      content.includes("Step 4") ||
      content.includes("## 4.") ||
      content.includes("## 4:");
    expect(hasStep4).toBe(true);
  });

  it("mentions extracting assistant text outputs", () => {
    const hasAssistant =
      content.includes("assistant") || content.includes("text output");
    expect(hasAssistant).toBe(true);
  });

  it("mentions extracting bash commands", () => {
    const hasBash =
      content.includes("Bash") ||
      content.includes("bash") ||
      content.includes("command");
    expect(hasBash).toBe(true);
  });
});

describe("SKILL.md — Step 5: synthesis / explanation", () => {
  it("has a Step 5 section for synthesizing the explanation", () => {
    const hasStep5 =
      content.includes("Step 5") ||
      content.includes("## 5.") ||
      content.includes("## 5:");
    expect(hasStep5).toBe(true);
  });

  it("covers what the output explanation should include (cron name, time, session)", () => {
    const coversOutput =
      (content.includes("cron name") || content.includes("cron,")) &&
      (content.includes("session") || content.includes("Session")) &&
      (content.includes("time") || content.includes("Time"));
    expect(coversOutput).toBe(true);
  });
});

describe("SKILL.md — graceful no-match handling", () => {
  it("handles the case where no matching session is found", () => {
    const hasNoMatch =
      content.includes("no match") ||
      content.includes("No match") ||
      content.includes("not found") ||
      content.includes("no session") ||
      content.includes("no matching session");
    expect(hasNoMatch).toBe(true);
  });

  it("mentions preCheck or bodhi.log as a fallback when no session exists", () => {
    const hasFallback =
      content.includes("preCheck") ||
      content.includes("pre-check") ||
      content.includes("bodhi.log") ||
      content.includes("logs/");
    expect(hasFallback).toBe(true);
  });
});
