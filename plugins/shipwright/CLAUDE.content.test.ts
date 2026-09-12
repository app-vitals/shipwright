import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLAUDE_MD_PATH = join(import.meta.dir, "CLAUDE.md");

/** The five loop-dispatched pipeline phases after PDR-4.1 added `plan`. */
const LOOP_PHASES = ["dev-task", "plan", "review", "patch", "deploy"] as const;

let fullContent: string;
let independenceSection: string;
let candidateSelectionSection: string;
let systemCronSection: string;

beforeAll(() => {
  const content = readFileSync(CLAUDE_MD_PATH, "utf-8");
  fullContent = content;
  const independenceStart = content.indexOf("## Independence Principles");
  const firstPrincipleStart = content.indexOf(
    "### 1. GitHub is the Source of Truth",
  );
  const candidateStart = content.indexOf("## Candidate Selection Contract");
  const systemCronStart = content.indexOf("## System Cron Changes");
  const envVarsStart = content.indexOf("## Environment Variables");
  independenceSection = content.slice(independenceStart, firstPrincipleStart);
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

  it("System Cron Changes reflects that dev-task, plan, review, patch, and deploy are dispatched phases, not independent crons", () => {
    for (const phase of LOOP_PHASES) {
      expect(systemCronSection).toContain(phase);
    }
  });
});

/**
 * Five-phase pipeline guards (PDR-4.1).
 *
 * PDR-4.1 wired `plan` in as the fifth loop-dispatched phase and rewrote the
 * Independence Principles preamble, the Candidate Selection Contract, and the System
 * Cron Changes section to match. Those rewrites are prose — nothing structurally
 * prevents a later edit (or a later phase addition) from reverting a section to the
 * four-phase story while leaving the others current, which is exactly the drift this
 * PR's own review cycles kept catching. These assertions pin the invariants that make
 * the three sections mutually consistent:
 *
 *  - every section that enumerates phases enumerates all five;
 *  - the two "no phase self-discovers its own work" claims state the set size as five,
 *    not four (asserted positively rather than by banning "four", because the Candidate
 *    Selection Contract legitimately says plan is gated "unlike the other four");
 *  - the plan phase's two distinguishing properties — it is double-gated behind
 *    `SHIPWRIGHT_AGENT_AUTONOMOUS_PLAN_SESSION_ENABLED`, and it ships disabled — are
 *    stated, since dropping either turns the doc into an overclaim about autonomy that
 *    a human reading it would act on.
 */

/** Matches the "no phase discovers its own work" claim, capturing its set size. */
const SELF_SCAN_CLAIM = /None of the (\w+)\s+(?:self-scans|scans)/;

const PLAN_KILL_SWITCH = "SHIPWRIGHT_AGENT_AUTONOMOUS_PLAN_SESSION_ENABLED";

describe("CLAUDE.md — five-phase pipeline (PDR-4.1)", () => {
  it("the Independence Principles preamble is present and names plan-session", () => {
    expect(independenceSection).not.toBe("");
    expect(independenceSection).toContain("plan-session");
  });

  it("every phase-enumerating section enumerates all five phases", () => {
    for (const section of [
      independenceSection,
      candidateSelectionSection,
      systemCronSection,
    ]) {
      for (const phase of LOOP_PHASES) {
        expect(section).toContain(phase);
      }
    }
  });

  it("the self-scan claims in both sections state the set size as five, not four", () => {
    for (const section of [independenceSection, systemCronSection]) {
      const match = section.match(SELF_SCAN_CLAIM);
      expect(match?.[1]).toBe("five");
    }
  });

  it("a human can invoke any of the five commands directly", () => {
    expect(candidateSelectionSection).toContain("any of the five commands");
  });

  it("the terminology note lists plan-session alongside the other four commands", () => {
    const terminologyNote = fullContent.slice(
      fullContent.indexOf("**Terminology note:**"),
      fullContent.indexOf("## Independence Principles"),
    );
    for (const phase of LOOP_PHASES.filter((p) => p !== "plan")) {
      expect(terminologyNote).toContain(phase);
    }
    expect(terminologyNote).toContain("plan-session");
  });

  it("the Candidate Selection Contract names check-plan.ts as the plan phase's provider", () => {
    expect(candidateSelectionSection).toContain("check-plan.ts");
    expect(candidateSelectionSection).toContain("getPlanCandidates");
  });

  it("the Candidate Selection Contract documents the autonomous dispatch form", () => {
    expect(candidateSelectionSection).toContain(
      "/shipwright:plan-session {repo} {session} --autonomous {task-id}",
    );
  });

  it("the Candidate Selection Contract documents the plan/dev-task dedupe", () => {
    expect(candidateSelectionSection).toContain("deduped by task id");
    expect(candidateSelectionSection).toContain("autonomousPlanSession=true");
  });

  it("the Candidate Selection Contract documents the plan phase's double gate", () => {
    expect(candidateSelectionSection).toContain(PLAN_KILL_SWITCH);
  });

  it("System Cron Changes declares shipwright-plan as a shipwright-loop child that ships disabled", () => {
    expect(systemCronSection).toContain("shipwright-plan");
    expect(systemCronSection).toContain('parentCron: "shipwright-loop"');
    expect(systemCronSection).toContain(PLAN_KILL_SWITCH);
    expect(systemCronSection).toMatch(
      /`deploy` and `plan` ship `enabled: false`/,
    );
  });
});
