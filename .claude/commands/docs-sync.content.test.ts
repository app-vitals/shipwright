import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DOCS_SYNC_MD_PATH = join(import.meta.dir, "docs-sync.md");

let content: string;

beforeAll(() => {
  content = readFileSync(DOCS_SYNC_MD_PATH, "utf-8");
});

describe("docs-sync.md — old Section Registry / full-regenerate flow removed", () => {
  it("no longer has a Section registry heading or table", () => {
    expect(content).not.toContain("## Section registry");
    expect(content).not.toMatch(
      /\|\s*Section\s*\|\s*Source Docs\s*\|\s*Target MDX\s*\|/i,
    );
  });

  it("no longer documents --section / --rebuild flags", () => {
    expect(content).not.toContain("--section");
    expect(content).not.toContain("--rebuild");
  });

  it("no longer frames the flow as regenerating the whole page from scratch", () => {
    expect(content).not.toMatch(/regenerate the whole page/i);
    expect(content).not.toMatch(/derive human-friendly content from scratch/i);
    expect(content).not.toContain("Regenerate MDX documentation from source");
    expect(content).not.toContain("## Example execution");
    expect(content).not.toContain(
      "Running `/docs-sync --section getting-started`",
    );
    expect(content).not.toContain("Running `/docs-sync --rebuild`");
  });

  it("no longer hardcodes the 11-section registry list", () => {
    expect(content).not.toContain("`getting-started`");
    expect(content).not.toContain("`introduction`");
    expect(content).not.toContain("`task-store`");
  });
});

describe("docs-sync.md — new flag/diff/propose/confirm flow present", () => {
  it("consumes site/docs-source-map.json as the source-of-truth mapping", () => {
    expect(content).toContain("site/docs-source-map.json");
  });

  it("consumes the check-site-docs-freshness.ts precheck output for flagged pages", () => {
    expect(content).toContain("check-site-docs-freshness.ts");
  });

  it("documents a --auto flag mirroring research-docs.md's convention", () => {
    expect(content).toMatch(/--auto/);
  });

  it("diffs each flagged page's mapped source(s) since its anchor SHA", () => {
    expect(content).toMatch(
      /git diff.{0,40}\{anchor[-_]?sha\}.{0,10}\.\.\.HEAD/i,
    );
  });

  it("proposes a targeted update rather than a full regenerate, citing the doc-refresh recipe", () => {
    expect(content).toMatch(/targeted (section-scoped )?update/i);
    expect(content).toContain("references/doc-refresh-recipe.md");
  });

  it("preserves the page's existing structure and voice", () => {
    expect(content).toMatch(
      /preserv(e|ing).{0,60}(existing )?structure.{0,40}voice|voice.{0,40}structure/is,
    );
  });

  it("interactive mode waits for explicit human confirmation before editing", () => {
    expect(content).toMatch(
      /wait(s|ing)? for (explicit )?(human )?confirmation/i,
    );
    expect(content).toMatch(/Apply.{0,10}Skip|Apply\/Skip/i);
  });

  it("auto mode files a hitl:true proposal task via the task-store bulk endpoint instead of auto-editing", () => {
    expect(content).toContain("/tasks/bulk");
    expect(content).toMatch(/"hitl":\s*true/);
    expect(content).toMatch(/never auto-edit/i);
  });

  it("auto mode's proposal tasks use a distinct session value for querying separately from docs-freshness-cron", () => {
    expect(content).toContain("docs-sync-cron");
  });

  it("auto mode's proposal tasks set a branch field to avoid dev-task silently stalling", () => {
    expect(content).toMatch(
      /docs\/site-\{page-slug\}-\{YYYYMMDD\}|docs\/site-.*-\{YYYYMMDD\}/,
    );
    expect(content).toMatch(/branch/i);
  });

  it("updates the page's anchor SHA in state/site-docs-last-synced.json on confirm/apply", () => {
    expect(content).toContain("state/site-docs-last-synced.json");
  });

  it("never auto-edits in auto mode, and never touches the anchor file except on an applied edit", () => {
    expect(content).toMatch(/never touch(es)? the anchor/i);
  });
});

describe("docs-sync.md — preserved verbatim sections", () => {
  it("preserves the Public-repo scrubbing rules section verbatim", () => {
    const idx = content.indexOf("## Public-repo scrubbing rules");
    expect(idx).toBeGreaterThan(-1);
    const section = content.slice(idx, idx + 1200);
    expect(section).toContain("**Do NOT include:**");
    expect(section).toContain(
      'Client/customer/partner names: "app-vitals", "Vitals", internal code names, customer accounts',
    );
    expect(section).toContain(
      "Internal infrastructure: Cloud project IDs, internal hostnames, internal Kubernetes cluster names, internal CDN URLs",
    );
    expect(section).toContain(
      "Internal URLs: GitHub links to private issues/PRs, Slack channel links, Jira issue links, internal wiki URLs",
    );
    expect(section).toContain(
      "Local filesystem paths with usernames: `/Users/<name>/`, `/home/<name>/`",
    );
    expect(section).toContain("Internal compensation, financials, or PII");
    expect(section).toContain("**Do include:**");
    expect(section).toContain(
      "Public GitHub URLs (e.g., the official shipwright-harness repo)",
    );
    expect(section).toContain(
      "Open-source project names and public documentation links",
    );
    expect(section).toContain(
      "Cloud provider names (AWS, GCP, Azure, etc.) and public documentation",
    );
    expect(section).toContain(
      "**If unsure:** Flag it for human review. It's better to ask than to commit proprietary content to a public repo.",
    );
  });

  it("preserves the frontmatter field rules verbatim", () => {
    expect(content).toContain("**Frontmatter field rules:**");
    expect(content).toContain(
      '- `title` (required): Human-readable section title (capitalize each major word). E.g., "Getting Started", "Task Store API", "Deployment Guide".',
    );
    expect(content).toContain(
      '- `description` (optional): A single sentence describing the section\'s purpose, written for someone new to Shipwright. E.g., "Clone the repo, install dependencies, and run the metrics dashboard locally in one prompt."',
    );
    expect(content).toContain(
      "- `order` (required): A number indicating the section's position in the navigation chain. Use increments of 1 (1, 2, 3, ...) or 10 (10, 20, 30, ...) for flexibility. Earlier sections should have lower order numbers.",
    );
    expect(content).toContain(
      "- `prev` (optional): The name of the previous section in the navigation chain (use the `section` value, not the filename). E.g., `prev: Getting Started`.",
    );
    expect(content).toContain(
      "- `next` (optional): The name of the next section in the navigation chain (use the `section` value, not the filename). E.g., `next: Configuration`.",
    );
  });

  it("preserves the Navigation chain explanation verbatim", () => {
    const idx = content.indexOf("**Navigation chain**");
    expect(idx).toBeGreaterThan(-1);
    const section = content.slice(idx, idx + 500);
    expect(section).toContain(
      "Using the section registry order, set `prev` and `next` to create a continuous chain through the docs.",
    );
    expect(section).toContain(
      "If a section has no predecessor or successor, omit the `prev` or `next` field.",
    );
  });

  it("preserves the build:check validation step verbatim", () => {
    expect(content).toContain(
      "Run `npm run build:check` from the `site/` directory to validate the Astro content collection against the schema.",
    );
    expect(content).toMatch(
      /If validation fails, print the error and halt with a non-zero exit code \(do not silently ignore schema violations\)\./,
    );
  });
});
