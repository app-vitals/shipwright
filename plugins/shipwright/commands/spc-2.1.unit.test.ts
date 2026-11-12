import { beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEV_TASK_PATH = join(import.meta.dir, "dev-task.md");
const PATCH_PATH = join(import.meta.dir, "patch.md");
const CLAUDE_MD_PATH = join(import.meta.dir, "..", "CLAUDE.md");

let devTask: string;
let patch: string;
let claudeMd: string;

beforeAll(() => {
  // dev-task.md is a short spine; path mechanics live in references/dev-task/.
  const refsDir = join(import.meta.dir, "..", "references", "dev-task");
  devTask = [
    readFileSync(DEV_TASK_PATH, "utf-8"),
    ...readdirSync(refsDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => readFileSync(join(refsDir, f), "utf-8")),
  ].join("\n\n");
  patch = readFileSync(PATCH_PATH, "utf-8");
  claudeMd = readFileSync(CLAUDE_MD_PATH, "utf-8");
});

// Helper: extract all bash code block contents from a markdown string
function bashBlocks(content: string): string {
  const blocks: string[] = [];
  const regex = /```bash\n([\s\S]*?)```/g;
  let match = regex.exec(content);
  while (match !== null) {
    blocks.push(match[1]);
    match = regex.exec(content);
  }
  return blocks.join("\n");
}

describe("dev-task.md — SHIPWRIGHT_REPO_DIR", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell path placeholder in asserted command-doc text, not JS interpolation
  it("replaces ~/src/{repo} with ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo-slug} in the dev-task prompt surface", () => {
    // Local filesystem paths use {repo-slug} (PRF-1.4) — SHIPWRIGHT_REPO_DIR clones live
    // flat as repos/<bare-name>, not repos/<org>/<repo>. {repo} (org/repo) remains reserved
    // for task-store API calls.
    const blocks = bashBlocks(devTask);
    expect(blocks).not.toContain("~/src/{repo}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell path placeholder in asserted command-doc text, not JS interpolation
    expect(devTask).toContain("${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo-slug}");
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell path placeholder in asserted command-doc text, not JS interpolation
  it("replaces ~/worktrees/{repo} with ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo-slug} in the dev-task prompt surface", () => {
    expect(devTask).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell path placeholder in asserted command-doc text, not JS interpolation
      "${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo-slug}",
    );
  });

  it("documents SHIPWRIGHT_REPO_DIR default as $HOME/src", () => {
    expect(devTask).toContain("$HOME/src");
  });
});

describe("patch.md — SHIPWRIGHT_REPO_DIR", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell path placeholder in asserted command-doc text, not JS interpolation
  it("replaces ~/src/{repo} with ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} in bash blocks", () => {
    const blocks = bashBlocks(patch);
    expect(blocks).not.toContain("~/src/{repo}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell path placeholder in asserted command-doc text, not JS interpolation
    expect(blocks).toContain("${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo}");
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell path placeholder in asserted command-doc text, not JS interpolation
  it("replaces ~/worktrees/{repo} with ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo} in bash blocks", () => {
    const blocks = bashBlocks(patch);
    expect(blocks).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell path placeholder in asserted command-doc text, not JS interpolation
      "${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}",
    );
  });

  it("documents SHIPWRIGHT_REPO_DIR default as $HOME/src", () => {
    expect(patch).toContain("$HOME/src");
  });
});

describe("dev-task.md — subagent prompt templates", () => {
  it("does NOT contain hardcoded ~/worktrees in Working directory directive", () => {
    expect(devTask).not.toContain("Working directory: ~/worktrees");
  });
});

describe("patch.md — subagent prompt templates", () => {
  it("does NOT contain hardcoded ~/worktrees in Worktree directive", () => {
    expect(patch).not.toContain("Worktree: ~/worktrees");
  });

  it("uses {worktree-path} placeholder in all subagent prompts", () => {
    const occurrences = (patch.match(/Worktree: \{worktree-path\}/g) ?? [])
      .length;
    expect(occurrences).toBe(3);
  });
});

describe("CLAUDE.md — Environment Variables section", () => {
  it("links to docs/configuration.md for env var reference", () => {
    expect(claudeMd).toContain("docs/configuration.md");
  });

  it("mentions SHIPWRIGHT_WORKTREE_DIR", () => {
    expect(claudeMd).toContain("SHIPWRIGHT_WORKTREE_DIR");
  });
});
