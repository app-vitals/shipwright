import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEV_TASK_PATH = join(import.meta.dir, "dev-task.md");
const PATCH_PATH = join(import.meta.dir, "patch.md");
const DEPLOY_PATH = join(import.meta.dir, "deploy.md");
const CLAUDE_MD_PATH = join(import.meta.dir, "..", "CLAUDE.md");

let devTask: string;
let patch: string;
let deploy: string;
let claudeMd: string;

beforeAll(() => {
  devTask = readFileSync(DEV_TASK_PATH, "utf-8");
  patch = readFileSync(PATCH_PATH, "utf-8");
  deploy = readFileSync(DEPLOY_PATH, "utf-8");
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
  it("replaces ~/src/{repo} with ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} in bash blocks", () => {
    const blocks = bashBlocks(devTask);
    expect(blocks).not.toContain("~/src/{repo}");
    expect(blocks).toContain("${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo}");
  });

  it("replaces ~/worktrees/{repo} with ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo} in bash blocks", () => {
    const blocks = bashBlocks(devTask);
    expect(blocks).toContain(
      "${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}",
    );
  });

  it("documents SHIPWRIGHT_REPO_DIR default as $HOME/src", () => {
    expect(devTask).toContain("$HOME/src");
  });
});

describe("patch.md — SHIPWRIGHT_REPO_DIR", () => {
  it("replaces ~/src/{repo} with ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} in bash blocks", () => {
    const blocks = bashBlocks(patch);
    expect(blocks).not.toContain("~/src/{repo}");
    expect(blocks).toContain("${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo}");
  });

  it("replaces ~/worktrees/{repo} with ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo} in bash blocks", () => {
    const blocks = bashBlocks(patch);
    expect(blocks).toContain(
      "${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}",
    );
  });

  it("documents SHIPWRIGHT_REPO_DIR default as $HOME/src", () => {
    expect(patch).toContain("$HOME/src");
  });
});

describe("deploy.md — SHIPWRIGHT_REPO_DIR", () => {
  it("replaces ~/src/{repo} with ${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo} in bash blocks", () => {
    const blocks = bashBlocks(deploy);
    expect(blocks).not.toContain("~/src/{repo}");
    expect(blocks).toContain("${SHIPWRIGHT_REPO_DIR:-$HOME/src}/{repo}");
  });

  it("replaces ~/worktrees/{repo} with ${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo} in bash blocks", () => {
    const blocks = bashBlocks(deploy);
    expect(blocks).toContain(
      "${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}",
    );
  });

  it("documents SHIPWRIGHT_REPO_DIR default as $HOME/src", () => {
    expect(deploy).toContain("$HOME/src");
  });
});

describe("dev-task.md — subagent prompt templates", () => {
  it("does NOT contain hardcoded ~/worktrees in Working directory directive", () => {
    expect(devTask).not.toContain("Working directory: ~/worktrees");
  });

  it("uses {worktree-path} placeholder in implementation subagent prompt", () => {
    expect(devTask).toContain("Working directory: {worktree-path}");
  });

  it("uses env var form for prose line (line ~176)", () => {
    expect(devTask).toContain(
      "${SHIPWRIGHT_WORKTREE_DIR:-$HOME/worktrees}/{repo}-{branch-slug}/",
    );
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
