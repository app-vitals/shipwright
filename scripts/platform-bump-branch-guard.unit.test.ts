import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  type BranchCommit,
  listBranchCommits,
  nonBotCommits,
  parseLog,
} from "./platform-bump-branch-guard.ts";

const BOT = "github-actions[bot]@users.noreply.github.com";
const c = (authorEmail: string, subject = "x"): BranchCommit => ({
  sha: "abcdef0123456789",
  authorEmail,
  subject,
});

describe("nonBotCommits", () => {
  test("bot-only branch has none", () => {
    expect(
      nonBotCommits([c(BOT), c("41898282+github-actions[bot]@users.noreply.github.com")]),
    ).toEqual([]);
  });
  test("mixed branch returns only the non-bot commits", () => {
    const human = c("dan@example.com", "fix: gate");
    expect(nonBotCommits([c(BOT), human])).toEqual([human]);
  });
  test("empty branch has none", () => {
    expect(nonBotCommits([])).toEqual([]);
  });
});

describe("parseLog", () => {
  test("splits sha, email and subject (subject may contain tabs)", () => {
    expect(parseLog("a1\te@x\tfix\tmore\n\n")).toEqual([
      { sha: "a1", authorEmail: "e@x", subject: "fix\tmore" },
    ]);
  });
});

describe("listBranchCommits", () => {
  const dir = mkdtempSync(join(tmpdir(), "bump-guard-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };
  const commit = (email: string, msg: string) => {
    writeFileSync(join(dir, "f"), msg);
    git("add", "f");
    git("-c", `user.email=${email}`, "-c", "user.name=n", "commit", "-qm", msg);
  };

  git("init", "-q", "-b", "main");
  commit("main@example.com", "base");
  git("checkout", "-qb", "bump");
  commit(BOT, "bump");
  commit("dan@example.com", "human fix");

  const inDir = (fn: () => BranchCommit[]) => {
    const prev = process.cwd();
    process.chdir(dir);
    try {
      return fn();
    } finally {
      process.chdir(prev);
    }
  };

  test("mixed branch: lists branch-only commits, flags the human one", () => {
    const commits = inDir(() => listBranchCommits("main", "bump"));
    expect(commits.map((x) => x.subject).sort()).toEqual(["bump", "human fix"]);
    expect(nonBotCommits(commits).map((x) => x.subject)).toEqual(["human fix"]);
  });
  test("no remote branch: nothing to protect", () => {
    expect(inDir(() => listBranchCommits("main", "origin/nope"))).toEqual([]);
  });
});
