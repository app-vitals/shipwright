/**
 * plugins/shipwright/scripts/check-site-docs-freshness.unit.test.ts
 *
 * Unit tests for check-site-docs-freshness.ts
 *
 * Design: mirrors check-docs-freshness.unit.test.ts's injected-dependency
 * style, but page-scoped rather than repo-scoped — one repo (cwd), N pages
 * from site/docs-source-map.json, each with its OWN last-synced anchor SHA.
 * Tests inject stub implementations — no file I/O or git commands are
 * executed.
 */

import { describe, expect, test } from "bun:test";
import { run } from "./check-site-docs-freshness.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface Anchor {
  sha: string;
  timestamp: string;
}

interface MakeDepsOptions {
  sourceMap?: Record<string, string[]>;
  readAnchor?: (page: string) => Anchor | null;
  getCommitsSince?: (paths: string[], sha: string) => string[] | null;
  getChangedFilesSince?: (paths: string[], sha: string) => string[] | null;
}

const SINGLE_PAGE_MAP: Record<string, string[]> = {
  "getting-started.mdx": ["docs/quickstart.md"],
};

function makeDeps(overrides: MakeDepsOptions = {}) {
  return {
    sourceMap: overrides.sourceMap ?? SINGLE_PAGE_MAP,
    readAnchor: overrides.readAnchor ?? (() => ({ sha: "abc123", timestamp: "2026-01-01T00:00:00Z" })),
    getCommitsSince:
      overrides.getCommitsSince ?? ((_paths: string[], _sha: string) => []),
    getChangedFilesSince:
      overrides.getChangedFilesSince ?? ((_paths: string[], _sha: string) => []),
  };
}

// ─── Single-page behavior ───────────────────────────────────────────────────

describe("check-site-docs-freshness — single page", () => {
  test("exits 0 (first run) when no anchor file exists at all", async () => {
    const deps = makeDeps({ readAnchor: () => null });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("getting-started.mdx");
  });

  test("exits 1 when no commits since last sync", async () => {
    const deps = makeDeps({
      readAnchor: () => ({ sha: "abc123", timestamp: "2026-01-01T00:00:00Z" }),
      getCommitsSince: () => [],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when commits exist but getChangedFilesSince returns no matching files", async () => {
    const deps = makeDeps({
      readAnchor: () => ({ sha: "abc123", timestamp: "2026-01-01T00:00:00Z" }),
      getCommitsSince: () => ["abc456 update quickstart"],
      getChangedFilesSince: () => [],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 with changed files when the mapped source path changed since anchor", async () => {
    const deps = makeDeps({
      readAnchor: () => ({ sha: "abc123", timestamp: "2026-01-01T00:00:00Z" }),
      getCommitsSince: () => ["def789 update quickstart"],
      getChangedFilesSince: () => ["docs/quickstart.md"],
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("getting-started.mdx");
    expect(result.output).toContain("docs/quickstart.md");
  });

  test("exits 0 when getCommitsSince returns null (git failure — permissive)", async () => {
    const deps = makeDeps({ getCommitsSince: () => null });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("getting-started.mdx");
  });

  test("exits 0 when getChangedFilesSince returns null (git failure — permissive)", async () => {
    const deps = makeDeps({
      getCommitsSince: () => ["abc456 some commit"],
      getChangedFilesSince: () => null,
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("getting-started.mdx");
  });

  test("exits 1 when the source map is empty", async () => {
    const result = await run(makeDeps({ sourceMap: {} }));
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("a directory-valued mapped source path is passed through to git helpers unchanged", async () => {
    const seenPaths: string[][] = [];
    const deps = makeDeps({
      sourceMap: { "agent-skills.mdx": ["plugins/shipwright/skills"] },
      readAnchor: () => ({ sha: "abc123", timestamp: "2026-01-01T00:00:00Z" }),
      getCommitsSince: (paths) => {
        seenPaths.push(paths);
        return ["def789 add skill"];
      },
      getChangedFilesSince: () => [
        "plugins/shipwright/skills/foo/SKILL.md",
      ],
    });
    const result = await run(deps);
    expect(seenPaths).toEqual([["plugins/shipwright/skills"]]);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("agent-skills.mdx");
    expect(result.output).toContain("plugins/shipwright/skills/foo/SKILL.md");
  });
});

// ─── Multi-page behavior ────────────────────────────────────────────────────

describe("check-site-docs-freshness — multi page", () => {
  test("evaluates every configured page independently", async () => {
    const sourceMap: Record<string, string[]> = {
      "page-a.mdx": ["docs/a.md"],
      "page-b.mdx": ["docs/b.md"],
    };
    const anchors: Record<string, Anchor | null> = {
      "page-a.mdx": { sha: "sha-a", timestamp: "2026-01-01T00:00:00Z" },
      "page-b.mdx": { sha: "sha-b", timestamp: "2026-01-01T00:00:00Z" },
    };
    const commits: Record<string, string[]> = {
      "sha-a": [],
      "sha-b": ["def456 update b"],
    };
    const changedFiles: Record<string, string[]> = {
      "sha-b": ["docs/b.md"],
    };

    const deps = makeDeps({
      sourceMap,
      readAnchor: (page) => anchors[page] ?? null,
      getCommitsSince: (_paths, sha) => commits[sha] ?? [],
      getChangedFilesSince: (_paths, sha) => changedFiles[sha] ?? [],
    });

    const result = await run(deps);
    expect(result.exit).toBe(0);
    // page-a had no commits since its anchor — should not appear
    expect(result.output).not.toContain("page-a.mdx");
    // page-b had a qualifying change — should be identified
    expect(result.output).toContain("page-b.mdx");
    expect(result.output).toContain("docs/b.md");
  });

  test("reads each page's own anchor independently (anchor keyed by page)", async () => {
    const sourceMap: Record<string, string[]> = {
      "page-a.mdx": ["docs/a.md"],
      "page-b.mdx": ["docs/b.md"],
    };

    const seenPages: string[] = [];
    const deps = makeDeps({
      sourceMap,
      readAnchor: (page) => {
        seenPages.push(page);
        // page-a has no anchor yet (first run); page-b has an anchor with no changes
        return page === "page-a.mdx"
          ? null
          : { sha: "sha-b", timestamp: "2026-01-01T00:00:00Z" };
      },
      getCommitsSince: () => [],
    });

    const result = await run(deps);
    expect(seenPages).toEqual(["page-a.mdx", "page-b.mdx"]);
    // page-a qualifies (first run); page-b does not (no commits since its own anchor)
    expect(result.exit).toBe(0);
    expect(result.output).toContain("page-a.mdx");
    expect(result.output).not.toContain("page-b.mdx");
  });

  test("a page newly added to the source map with no anchor entry qualifies (per-page first-run) even when other pages have anchors", async () => {
    const sourceMap: Record<string, string[]> = {
      "existing-page.mdx": ["docs/existing.md"],
      "new-page.mdx": ["docs/new.md"],
    };

    const deps = makeDeps({
      sourceMap,
      readAnchor: (page) =>
        page === "existing-page.mdx"
          ? { sha: "sha-existing", timestamp: "2026-01-01T00:00:00Z" }
          : null,
      getCommitsSince: () => [],
    });

    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("new-page.mdx");
    expect(result.output).not.toContain("existing-page.mdx");
  });

  test("a page whose git commands fail does not block findings for another page", async () => {
    const sourceMap: Record<string, string[]> = {
      "failing-page.mdx": ["docs/failing.md"],
      "good-page.mdx": ["docs/good.md"],
    };

    const deps = makeDeps({
      sourceMap,
      readAnchor: () => ({ sha: "sha-anchor", timestamp: "2026-01-01T00:00:00Z" }),
      getCommitsSince: (paths) => {
        if (paths[0] === "docs/failing.md") return null; // git failure
        return ["def789 add feature"];
      },
      getChangedFilesSince: (paths) => {
        if (paths[0] === "docs/good.md") return ["docs/good.md"];
        return [];
      },
    });

    const result = await run(deps);
    expect(result.exit).toBe(0);
    // Permissive: failing page still surfaces (unknown state, worth checking)
    expect(result.output).toContain("failing-page.mdx");
    // Good page's real finding is not suppressed by the other page's failure
    expect(result.output).toContain("good-page.mdx");
    expect(result.output).toContain("docs/good.md");
  });

  test("exits 1 when every configured page has an anchor and nothing changed", async () => {
    const sourceMap: Record<string, string[]> = {
      "page-a.mdx": ["docs/a.md"],
      "page-b.mdx": ["docs/b.md"],
    };

    const deps = makeDeps({
      sourceMap,
      readAnchor: () => ({ sha: "sha-anchor", timestamp: "2026-01-01T00:00:00Z" }),
      getCommitsSince: () => [],
    });

    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("identifies which page(s) need a check in the output (not just a flat file list)", async () => {
    const sourceMap: Record<string, string[]> = {
      "page-a.mdx": ["docs/a.md"],
    };

    const deps = makeDeps({
      sourceMap,
      readAnchor: () => ({ sha: "sha-a", timestamp: "2026-01-01T00:00:00Z" }),
      getCommitsSince: () => ["def789 change"],
      getChangedFilesSince: () => ["docs/a.md"],
    });

    const result = await run(deps);
    expect(result.exit).toBe(0);
    // Page identity must be present in the output, not just bare file paths.
    expect(result.output).toContain("page-a.mdx");
  });
});
