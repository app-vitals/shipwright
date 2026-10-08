import { describe, expect, test } from "bun:test";
import {
  type ContextStampDeps,
  computeContextStamp,
  extractImports,
  hasPathsFrontmatter,
} from "./context-stamp.ts";

const WORKSPACE = "/ws";

function makeDeps(
  files: Record<string, string>,
  overrides: Partial<ContextStampDeps> = {},
): ContextStampDeps {
  return {
    workspace: WORKSPACE,
    readFile: (abs) => files[abs] ?? null,
    listRuleFiles: () =>
      Object.keys(files).filter((p) =>
        p.startsWith(`${WORKSPACE}/.claude/rules/`),
      ),
    pluginVersion: () => "1.363.0",
    claudeCodeVersion: () => "2.1.285",
    ...overrides,
  };
}

describe("extractImports", () => {
  test("finds @path imports and ignores code spans, fences, and emails", () => {
    const content = [
      "# Title",
      "@SOUL.md",
      "- identity @IDENTITY.md and voice @VOICE.md.",
      "Mention `@README` literally.",
      "```",
      "@NOT_IMPORTED.md",
      "```",
      "Contact ops@example.com",
      "@Design\\ Docs/api.md",
    ].join("\n");
    expect(extractImports(content)).toEqual([
      "SOUL.md",
      "IDENTITY.md",
      "VOICE.md",
      "Design Docs/api.md",
    ]);
  });
});

describe("hasPathsFrontmatter", () => {
  test("detects a paths key in frontmatter only", () => {
    expect(hasPathsFrontmatter("---\npaths:\n  - src/**\n---\nbody")).toBe(
      true,
    );
    expect(hasPathsFrontmatter("---\ndescription: x\n---\npaths: not fm")).toBe(
      false,
    );
    expect(hasPathsFrontmatter("no frontmatter\npaths:")).toBe(false);
  });
});

describe("computeContextStamp", () => {
  const base = {
    [`${WORKSPACE}/CLAUDE.md`]: "# Agent\n@SOUL.md\n",
    [`${WORKSPACE}/SOUL.md`]: "be kind",
    [`${WORKSPACE}/.claude/rules/always.md`]: "always rule",
    [`${WORKSPACE}/.claude/rules/scoped.md`]:
      "---\npaths:\n  - x/**\n---\nscoped",
  };

  test("is stable for identical inputs and 12 hex chars long", () => {
    const a = computeContextStamp(makeDeps(base));
    const b = computeContextStamp(makeDeps(base));
    expect(a.contextFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(a).toEqual(b);
    expect(a.pluginVersion).toBe("1.363.0");
    expect(a.claudeCodeVersion).toBe("2.1.285");
  });

  test("changes when CLAUDE.md, an import, an always-rule, or the plugin version changes", () => {
    const ref = computeContextStamp(makeDeps(base)).contextFingerprint;
    const edits: Array<Record<string, string>> = [
      { [`${WORKSPACE}/CLAUDE.md`]: "# Agent v2\n@SOUL.md\n" },
      { [`${WORKSPACE}/SOUL.md`]: "be kinder" },
      { [`${WORKSPACE}/.claude/rules/always.md`]: "always rule v2" },
    ];
    for (const edit of edits) {
      const fp = computeContextStamp(
        makeDeps({ ...base, ...edit }),
      ).contextFingerprint;
      expect(fp).not.toBe(ref);
    }
    const bumped = computeContextStamp(
      makeDeps(base, { pluginVersion: () => "1.364.0" }),
    ).contextFingerprint;
    expect(bumped).not.toBe(ref);
  });

  test("ignores path-scoped rules, which load on demand", () => {
    const ref = computeContextStamp(makeDeps(base)).contextFingerprint;
    const edited = computeContextStamp(
      makeDeps({
        ...base,
        [`${WORKSPACE}/.claude/rules/scoped.md`]:
          "---\npaths:\n  - x/**\n---\nscoped v2",
      }),
    ).contextFingerprint;
    expect(edited).toBe(ref);
  });

  test("rule order does not affect the fingerprint", () => {
    const files = {
      ...base,
      [`${WORKSPACE}/.claude/rules/b.md`]: "b",
      [`${WORKSPACE}/.claude/rules/a.md`]: "a",
    };
    const forward = computeContextStamp(makeDeps(files)).contextFingerprint;
    const reversed = computeContextStamp(
      makeDeps(files, {
        listRuleFiles: () =>
          Object.keys(files)
            .filter((p) => p.includes("/.claude/rules/"))
            .reverse(),
      }),
    ).contextFingerprint;
    expect(reversed).toBe(forward);
  });

  test("a workspace with no CLAUDE.md still produces a stamp", () => {
    const stamp = computeContextStamp(
      makeDeps(
        {},
        { pluginVersion: () => null, claudeCodeVersion: () => null },
      ),
    );
    expect(stamp.contextFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(stamp.pluginVersion).toBeNull();
    expect(stamp.claudeCodeVersion).toBeNull();
  });
});
