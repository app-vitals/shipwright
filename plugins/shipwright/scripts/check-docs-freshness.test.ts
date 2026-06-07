/**
 * plugins/shipwright/scripts/check-docs-freshness.test.ts
 *
 * Unit tests for check-docs-freshness.ts
 *
 * Design: the script exports a `run(deps)` function that accepts injected
 * dependencies. Tests inject stub implementations — no file I/O or git
 * commands are executed.
 */

import { describe, expect, test } from "bun:test";
import { run } from "./check-docs-freshness.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDeps(overrides: {
  readSyncAnchor?: () => string | null;
  getCommitsSince?: (sha: string) => string[] | null;
  getChangedFilesSince?: (sha: string) => string[] | null;
}) {
  return {
    readSyncAnchor: overrides.readSyncAnchor ?? (() => "abc123"),
    getCommitsSince: overrides.getCommitsSince ?? ((_sha: string) => []),
    getChangedFilesSince:
      overrides.getChangedFilesSince ?? ((_sha: string) => []),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("check-docs-freshness", () => {
  test("exits 0 (first run) when no sync anchor file exists", async () => {
    const deps = makeDeps({ readSyncAnchor: () => null });
    const result = await run(deps);
    expect(result.exit).toBe(0);
  });

  test("exits 1 when no commits since last sync", async () => {
    const deps = makeDeps({
      readSyncAnchor: () => "abc123",
      getCommitsSince: () => [],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when commits exist but only docs/ files changed", async () => {
    const deps = makeDeps({
      readSyncAnchor: () => "abc123",
      getCommitsSince: () => ["abc456 update docs"],
      getChangedFilesSince: () => ["docs/modules/auth.md", "docs/overview.md"],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when source files have changed since last sync", async () => {
    const deps = makeDeps({
      readSyncAnchor: () => "abc123",
      getCommitsSince: () => ["def789 add feature"],
      getChangedFilesSince: () => [
        "src/auth/handler.ts",
        "src/billing/index.ts",
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
  });

  test("exits 1 when only state/ files changed", async () => {
    const deps = makeDeps({
      readSyncAnchor: () => "abc123",
      getCommitsSince: () => ["def789 update state"],
      getChangedFilesSince: () => [
        "state/todos.json",
        "state/docs-last-synced.json",
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when only .github/ files changed", async () => {
    const deps = makeDeps({
      readSyncAnchor: () => "abc123",
      getCommitsSince: () => ["def789 update ci"],
      getChangedFilesSince: () => [
        ".github/workflows/ci.yml",
        ".github/CODEOWNERS",
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 output includes newline-separated list of changed source files", async () => {
    const changedFiles = ["accounts/src/handler.ts", "billing/src/invoice.ts"];
    const deps = makeDeps({
      readSyncAnchor: () => "abc123",
      getCommitsSince: () => ["def789 add billing feature"],
      getChangedFilesSince: () => changedFiles,
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("accounts/src/handler.ts");
    expect(result.output).toContain("billing/src/invoice.ts");
  });

  test("filters out docs/ files but includes remaining source files", async () => {
    const deps = makeDeps({
      readSyncAnchor: () => "abc123",
      getCommitsSince: () => ["def789 mixed commit"],
      getChangedFilesSince: () => [
        "docs/modules/billing.md",
        "billing/src/invoice.ts",
        "state/todos.json",
      ],
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("billing/src/invoice.ts");
    expect(result.output).not.toContain("docs/modules/billing.md");
    expect(result.output).not.toContain("state/todos.json");
  });

  test("exits 0 when getCommitsSince returns null (git failure — permissive)", async () => {
    const deps = makeDeps({ getCommitsSince: () => null });
    const result = await run(deps);
    expect(result.exit).toBe(0);
  });

  test("exits 0 when getChangedFilesSince returns null (git failure — permissive)", async () => {
    const deps = makeDeps({
      getCommitsSince: () => ["abc456 some commit"],
      getChangedFilesSince: () => null,
    });
    const result = await run(deps);
    expect(result.exit).toBe(0);
  });
});
