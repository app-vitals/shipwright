/**
 * CLAUDE.md.template content regression guard — DPF-1.1
 *
 * Verifies the deployed-agent template's "Shipwright" section describes the
 * shipwright-loop-driven, explicit-target-only pipeline model (WLS-6.1), not
 * the stale self-discovering-cron model it replaced. Also verifies the
 * template tells Slack-mediated agents not to use AskUserQuestion.
 *
 * Content-assertion only: readFileSync, no I/O beyond local file reads.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// agent/workspace/ → repo root
const repoRoot = resolve(import.meta.dir, "..", "..");

function repoPath(...parts: string[]): string {
  return join(repoRoot, ...parts);
}

function readTemplate(): string {
  return readFileSync(repoPath("agent/workspace/CLAUDE.md.template"), "utf8");
}

describe("CLAUDE.md.template — shipwright-loop model", () => {
  it("mentions the shipwright-loop cron as the driver", () => {
    expect(readTemplate()).toContain("shipwright-loop");
  });

  it("describes dev-task/review/patch/deploy as explicit-target-only executors", () => {
    expect(readTemplate().toLowerCase()).toContain("explicit-target-only");
  });

  it("mentions strict age-based FIFO work selection", () => {
    expect(readTemplate().toLowerCase()).toContain("fifo");
  });

  it("notes a standalone phase cron with shipwright-loop disabled is silently inert", () => {
    expect(readTemplate().toLowerCase()).toContain("silently inert");
  });

  it("does not claim dev-task picks up pending items on a fixed schedule independent of the loop", () => {
    expect(readTemplate()).not.toContain(
      "picks up the next pending item every 30 minutes",
    );
  });

  it("does not describe review/patch as independently self-discovering phases", () => {
    expect(readTemplate()).not.toContain(
      "run as independent phases — review posts",
    );
  });
});

describe("CLAUDE.md.template — Slack AskUserQuestion note", () => {
  it("mentions AskUserQuestion", () => {
    expect(readTemplate()).toContain("AskUserQuestion");
  });

  it("instructs asking clarifying questions as plain text instead", () => {
    expect(readTemplate().toLowerCase()).toContain("plain text");
  });
});

describe("CLAUDE.md.template — Agent tool background-dispatch warning", () => {
  it("mentions run_in_background: false in the Waiting and Polling section", () => {
    expect(readTemplate()).toContain("run_in_background: false");
  });

  it("explains the Agent tool defaults to background dispatch", () => {
    expect(readTemplate()).toContain("run_in_background: true");
  });

  it("draws the parallel to ScheduleWakeup failure mode in the same section", () => {
    const template = readTemplate();
    // Extract just the Waiting and Polling section to ensure context
    const waitingSection = template.slice(
      template.indexOf("### Waiting and Polling"),
    );
    expect(waitingSection.toLowerCase()).toContain("schedulewakeup");
    expect(waitingSection.toLowerCase()).toContain("same");
  });

  it("instructs that cron-dispatched work needing results must pass run_in_background: false", () => {
    const template = readTemplate();
    expect(template.toLowerCase()).toContain("cron");
    expect(template).toContain("run_in_background: false");
  });

  it("clarifies that multiple foreground Agent calls still run concurrently", () => {
    expect(readTemplate().toLowerCase()).toContain("concurrently");
  });
});
