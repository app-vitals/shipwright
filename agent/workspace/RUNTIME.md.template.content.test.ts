/**
 * RUNTIME.md.template content regression guard — DPF-1.1
 *
 * Verifies the runtime-owned workspace file tells Slack-mediated agents not to
 * use AskUserQuestion and warns about background Agent dispatch. Relocated from
 * CLAUDE.md.template.content.test.ts when the template was layered (ARD-6.2).
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
  return readFileSync(repoPath("agent/workspace/RUNTIME.md.template"), "utf8");
}

describe("RUNTIME.md.template — Slack AskUserQuestion note", () => {
  it("mentions AskUserQuestion", () => {
    expect(readTemplate()).toContain("AskUserQuestion");
  });

  it("instructs asking clarifying questions as plain text instead", () => {
    expect(readTemplate().toLowerCase()).toContain("plain text");
  });
});

describe("RUNTIME.md.template — Agent tool background-dispatch warning", () => {
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
