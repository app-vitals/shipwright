/**
 * SPECIALTY.md.template content regression guard — DPF-1.1
 *
 * Verifies the coding specialty's "Shipwright" section describes the
 * shipwright-loop-driven, explicit-target-only pipeline model (WLS-6.1), not
 * the stale self-discovering-cron model it replaced. Relocated from
 * the former CLAUDE template content test when the template was layered (ARD-6.2).
 *
 * Content-assertion only: readFileSync, no I/O beyond local file reads.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The template sits beside this test, so this works in any repo layout.
const TEMPLATE_PATH = join(import.meta.dir, "SPECIALTY.md.template");

function readTemplate(): string {
  return readFileSync(TEMPLATE_PATH, "utf8");
}

describe("SPECIALTY.md.template — shipwright-loop model", () => {
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
