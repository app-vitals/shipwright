/**
 * scripts/docs-source-map.unit.test.ts
 *
 * Structural validity checks for site/docs-source-map.json — the audit artifact
 * mapping every site/src/content/docs mdx page to the docs/ markdown,
 * plugins/shipwright/commands markdown, and plugins/shipwright/skills
 * SKILL.md source(s) it is substantively derived from (SDR-1).
 *
 * This lives at the repo root (not under site/) because site/** is excluded
 * from the root `bun test` scan (see bunfig.toml's pathIgnorePatterns) — the
 * map itself must still live at site/docs-source-map.json per the task's
 * acceptance criteria, but its test needs to run under `bun test` and needs
 * read access to docs/, plugins/, and site/ from the repo root.
 *
 * Does real filesystem I/O (glob + existsSync) — that's expected and
 * idiomatic for a static-content-assertion test like this one; see
 * scripts/check-config-docs.unit.test.ts for the same pattern.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dirname, "..");
const MAP_PATH = join(REPO_ROOT, "site", "docs-source-map.json");
const DOCS_DIR = join(REPO_ROOT, "site", "src", "content", "docs");

/** Every current *.mdx filename under site/src/content/docs/, e.g. "getting-started.mdx". */
function currentDocPages(): string[] {
  return readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith(".mdx"))
    .sort();
}

/** Keys in the map that represent metadata rather than a page → sources entry. */
const NON_PAGE_KEYS = new Set(["_comment", "_notes"]);

describe("site/docs-source-map.json", () => {
  test("exists and is valid JSON", () => {
    expect(existsSync(MAP_PATH)).toBe(true);
    const raw = readFileSync(MAP_PATH, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test("covers every current .mdx page under site/src/content/docs/", () => {
    const raw = readFileSync(MAP_PATH, "utf8");
    const map = JSON.parse(raw) as Record<string, unknown>;
    const pages = currentDocPages();

    expect(pages.length).toBeGreaterThan(0);

    for (const page of pages) {
      expect(Object.hasOwn(map, page)).toBe(true);
    }
  });

  test("does not contain stale page entries no longer under site/src/content/docs/", () => {
    const raw = readFileSync(MAP_PATH, "utf8");
    const map = JSON.parse(raw) as Record<string, unknown>;
    const pages = new Set(currentDocPages());

    for (const key of Object.keys(map)) {
      if (NON_PAGE_KEYS.has(key)) continue;
      expect(pages.has(key)).toBe(true);
    }
  });

  test("every page entry is an array of source path strings", () => {
    const raw = readFileSync(MAP_PATH, "utf8");
    const map = JSON.parse(raw) as Record<string, unknown>;

    for (const [key, value] of Object.entries(map)) {
      if (NON_PAGE_KEYS.has(key)) continue;
      expect(Array.isArray(value)).toBe(true);
      for (const entry of value as unknown[]) {
        expect(typeof entry).toBe("string");
      }
    }
  });

  test("every listed source path exists on disk relative to the repo root", () => {
    const raw = readFileSync(MAP_PATH, "utf8");
    const map = JSON.parse(raw) as Record<string, unknown>;

    for (const [key, value] of Object.entries(map)) {
      if (NON_PAGE_KEYS.has(key)) continue;
      for (const sourcePath of value as string[]) {
        const resolved = join(REPO_ROOT, sourcePath);
        expect(existsSync(resolved)).toBe(true);
      }
    }
  });

  test("every page not listed with an empty array has at least one source", () => {
    const raw = readFileSync(MAP_PATH, "utf8");
    const map = JSON.parse(raw) as Record<string, unknown>;
    const notes = (map._notes ?? {}) as Record<string, string>;

    for (const page of currentDocPages()) {
      const sources = map[page] as string[];
      if (sources.length === 0) {
        // An empty array is only acceptable when accompanied by an explanatory
        // note documenting why the page has no repo-doc source.
        expect(typeof notes[page]).toBe("string");
        expect(notes[page].length).toBeGreaterThan(0);
      }
    }
  });
});
