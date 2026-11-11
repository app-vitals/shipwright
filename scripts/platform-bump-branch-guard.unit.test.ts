import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BranchCommit,
  foreignToProtect,
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
      nonBotCommits([
        c(BOT),
        c("41898282+github-actions[bot]@users.noreply.github.com"),
      ]),
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

describe("foreignToProtect", () => {
  const commits = [c(BOT, "bump"), c("dan@example.com", "human fix")];
  test("open PR: non-bot commits are protected", () => {
    expect(foreignToProtect(commits, true).map((x) => x.subject)).toEqual([
      "human fix",
    ]);
  });
  test("no open PR: stale branch, nothing to protect", () => {
    expect(foreignToProtect(commits, false)).toEqual([]);
  });
});

describe("guard CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "bump-guard-cli-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "f"), "a");
  git("add", "f");
  git(
    "-c",
    "user.email=m@example.com",
    "-c",
    "user.name=n",
    "commit",
    "-qm",
    "base",
  );
  git("checkout", "-qb", "bump");
  writeFileSync(join(dir, "f"), "b");
  git(
    "-c",
    "user.email=dan@example.com",
    "-c",
    "user.name=n",
    "commit",
    "-aqm",
    "human fix",
  );
  const script = join(import.meta.dir, "platform-bump-branch-guard.ts");
  const run = (...extra: string[]) =>
    spawnSync("bun", [script, "main", "bump", ...extra], {
      cwd: dir,
      encoding: "utf8",
    });

  test("no pr-url (no open PR): exits 0 despite non-bot commits", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("foreign=0");
  });
  test("empty pr-url: exits 0", () => {
    expect(run("").status).toBe(0);
  });
  test("open PR url: exits 1 on non-bot commits", () => {
    const r = run("https://github.com/o/r/pull/1");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("foreign=1");
  });
});
