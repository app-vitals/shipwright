/**
 * Default system crons table content tests — SUX-1.1
 *
 * site/src/content/docs/the-agent.mdx and site/src/content/docs/cron-jobs.mdx used to both
 * carry a "Default system crons" table, and they had drifted out of sync with each other and
 * with the coding specialty's code defaults (admin/src/coding/coding-specialty-defaults.ts,
 * the actual source of truth).
 *
 * cron-jobs.mdx is now the single source of truth for this table. This test guards against
 * re-drift:
 *   - every cron name declared in the code defaults appears exactly once in cron-jobs.mdx's
 *     "Default system crons" table
 *   - the-agent.mdx no longer contains any cron names at all (it should only link to
 *     cron-jobs.mdx instead of re-documenting the table)
 *   - cron-jobs.mdx's table header includes the new Command and Skill columns
 *
 * Content-assertion only: existsSync/readFileSync, no I/O beyond local file reads.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CODING_SPECIALTY_DEFAULTS } from "../../../admin/src/coding/coding-specialty-defaults.ts";

// plugins/shipwright/test/ → repo root
const repoRoot = resolve(import.meta.dir, "..", "..", "..");

const cronJobsDocPath = join(
  repoRoot,
  "site",
  "src",
  "content",
  "docs",
  "cron-jobs.mdx",
);
const theAgentDocPath = join(
  repoRoot,
  "site",
  "src",
  "content",
  "docs",
  "the-agent.mdx",
);

function readCronJobsDoc(): string {
  return readFileSync(cronJobsDocPath, "utf8");
}

/**
 * Isolate the "Default system crons" table's own lines (header + separator + rows), so
 * assertions about "exactly once" aren't tripped up by legitimate prose mentions of a cron
 * name elsewhere on the page (e.g. "Loop-driven vs standalone crons").
 */
function readCronJobsTableBlock(): string {
  const doc = readCronJobsDoc();
  const headingIdx = doc.indexOf("### Default system crons");
  expect(headingIdx).toBeGreaterThanOrEqual(0);

  const tableStart = doc.indexOf("| Cron", headingIdx);
  expect(tableStart).toBeGreaterThan(headingIdx);

  const tableEnd = doc.indexOf("\n\n", tableStart);
  expect(tableEnd).toBeGreaterThan(tableStart);

  return doc.slice(tableStart, tableEnd);
}

function readTheAgentDoc(): string {
  return readFileSync(theAgentDocPath, "utf8");
}

/** Cron names declared by the coding specialty's code defaults. */
function getDefaultCronNames(): string[] {
  const names = (CODING_SPECIALTY_DEFAULTS.crons ?? []).map((c) => c.name);
  expect(names.length).toBeGreaterThan(0);
  return names;
}

// ── Files exist ───────────────────────────────────────────────────────────────

describe("cron table docs — files", () => {
  it("site/src/content/docs/cron-jobs.mdx exists", () => {
    expect(existsSync(cronJobsDocPath)).toBe(true);
  });

  it("site/src/content/docs/the-agent.mdx exists", () => {
    expect(existsSync(theAgentDocPath)).toBe(true);
  });
});

// ── cron-jobs.mdx is the single source of truth ──────────────────────────────

describe("cron-jobs.mdx — Default system crons table", () => {
  it("contains a 'Default system crons' heading", () => {
    expect(readCronJobsDoc()).toContain("Default system crons");
  });

  it("has a table header row with both Command and Skill columns", () => {
    const tableBlock = readCronJobsTableBlock();
    const headerLine = tableBlock.split("\n")[0];

    expect(headerLine).toContain("Cron");
    expect(headerLine).toContain("Schedule");
    expect(headerLine).toContain("Command");
    expect(headerLine).toContain("Skill");
  });

  for (const cronName of getDefaultCronNames()) {
    it(`includes every default cron exactly once as a table row: \`${cronName}\``, () => {
      const tableBlock = readCronJobsTableBlock();
      // Match the cron name only in the leading "Cron" column of a row, e.g.
      // "| `shipwright-loop` |" — this avoids over-counting prose mentions of the same
      // cron name inside other rows' "What it does" cells (e.g. "shipwright-loop" is
      // referenced by every pipeline-cron row's description).
      const rowCellPattern = new RegExp(`^\\|\\s*\`${cronName}\`\\s*\\|`, "gm");
      const occurrences = [...tableBlock.matchAll(rowCellPattern)].length;
      expect(occurrences).toBe(1);
    });
  }
});

// ── the-agent.mdx no longer documents the table (regression guard) ──────────

describe("the-agent.mdx — no cron table drift", () => {
  it("does not contain a cron table (no 'Cron | Schedule' header row)", () => {
    const doc = readTheAgentDoc();
    const hasCronTableHeader = doc
      .split("\n")
      .some((line) => line.includes("| Cron") && line.includes("Schedule"));

    expect(hasCronTableHeader).toBe(false);
  });

  it("links to cron-jobs.mdx instead of re-documenting crons", () => {
    expect(readTheAgentDoc()).toContain("cron-jobs");
  });

  for (const cronName of getDefaultCronNames()) {
    it(`does not mention default cron name: \`${cronName}\``, () => {
      expect(readTheAgentDoc()).not.toContain(cronName);
    });
  }
});
