import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Behaviour test for the docs-PR shell block in prd.md (PLU-3.2). The block is
 * extracted verbatim and run against a real local git repo + bare origin, with a
 * `gh` shim on PATH (the only network seam).
 */

const PRD_MD = readFileSync(join(import.meta.dir, "prd.md"), "utf-8");

function extractBlock(): string {
  const start = PRD_MD.indexOf("```bash\n# prd-docs-pr");
  expect(start).toBeGreaterThan(-1);
  const bodyStart = start + "```bash\n".length;
  return PRD_MD.slice(bodyStart, PRD_MD.indexOf("\n```", bodyStart));
}

const GH_SHIM = `#!/bin/bash
# state files: $GH_STATE/<branch with / -> _> holds "STATE URL"
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  while [ $# -gt 0 ]; do [ "$1" = "--head" ] && B="$2"; shift; done
  f="$GH_STATE/\${B//\\//_}"
  [ -f "$f" ] && cat "$f"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  while [ $# -gt 0 ]; do [ "$1" = "--head" ] && B="$2"; shift; done
  echo "$B" >> "$GH_STATE/created"
  echo "https://github.com/o/r/pull/99"
  exit 0
fi
exit 0
`;

let dir: string;
let work: string;
let origin: string;
let state: string;

function sh(cmd: string, cwd = work, env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bash", "-c", cmd], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      ...env,
    },
  });
  return {
    code: r.exitCode,
    out: r.stdout.toString(),
    err: r.stderr.toString(),
  };
}

function runBlock(spec: string, specFile: string, content: string) {
  mkdirSync(join(work, "planning", spec), { recursive: true });
  writeFileSync(join(work, "planning", spec, specFile), content);
  const script = extractBlock()
    .replace('SESSION="{session}"', `SESSION="${spec}"`)
    .replace('SPEC_FILE="{SPEC_FILE}"', `SPEC_FILE="${specFile}"`);
  const r = sh(script, work, {
    PATH: `${join(dir, "bin")}:${process.env.PATH}`,
    GH_STATE: state,
  });
  expect(r.code).toBe(0);
  const field = (k: string) =>
    new RegExp(`^${k}=(.*)$`, "m").exec(r.out)?.[1] ?? "";
  return {
    ...r,
    branch: field("SPEC_PR_BRANCH"),
    url: field("SPEC_PR_URL"),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prd-docs-pr-"));
  origin = join(dir, "origin.git");
  work = join(dir, "work");
  state = join(dir, "state");
  mkdirSync(state);
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "gh"), GH_SHIM);
  chmodSync(join(dir, "bin", "gh"), 0o755);
  const env = `export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com`;
  sh(`${env}; git init -q --bare -b main ${origin}`, dir);
  sh(
    `${env}; git clone -q ${origin} work && cd work && git checkout -q -b main && echo x > README.md && echo planning/ > .gitignore && git add README.md .gitignore && git commit -q -m init && git push -q -u origin main && git remote set-head origin main`,
    dir,
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const remoteBranches = () =>
  sh(`git ls-remote --heads ${origin}`, dir).out;

describe("prd.md docs PR shell block (behaviour)", () => {
  it("opens docs/plan-{session} when no PR exists, force-adding the file despite .gitignore", () => {
    const r = runBlock("s1", "SPEC-0001.md", "# Spec\n");
    expect(r.branch).toBe("docs/plan-s1");
    expect(r.url).toBe("https://github.com/o/r/pull/99");
    expect(remoteBranches()).toContain("refs/heads/docs/plan-s1");
    const tree = sh(
      `git --git-dir=${origin} ls-tree -r --name-only docs/plan-s1`,
      dir,
    ).out;
    expect(tree).toContain("planning/s1/SPEC-0001.md");
    expect(readFileSync(join(work, ".gitignore"), "utf-8")).toBe("planning/\n");
  });

  it("reuses an open docs/plan-{session} PR: pushes to its branch and opens no new PR", () => {
    runBlock("s2", "SPEC-0001.md", "# One\n");
    writeFileSync(
      join(state, "docs_plan-s2"),
      "OPEN https://github.com/o/r/pull/7\n",
    );
    const r = runBlock("s2", "SPEC-0002.md", "# Two\n");
    expect(r.branch).toBe("docs/plan-s2");
    expect(r.url).toBe("https://github.com/o/r/pull/7");
    const tree = sh(
      `git --git-dir=${origin} ls-tree -r --name-only docs/plan-s2`,
      dir,
    ).out;
    expect(tree).toContain("planning/s2/SPEC-0001.md");
    expect(tree).toContain("planning/s2/SPEC-0002.md");
    expect(readFileSync(join(state, "created"), "utf-8").trim().split("\n")).toEqual([
      "docs/plan-s2",
    ]);
  });

  it("opens docs/plan-{session}-2 when the previous PR has merged", () => {
    writeFileSync(
      join(state, "docs_plan-s3"),
      "MERGED https://github.com/o/r/pull/5\n",
    );
    const r = runBlock("s3", "SPEC-0002.md", "# Two\n");
    expect(r.branch).toBe("docs/plan-s3-2");
    expect(r.url).toBe("https://github.com/o/r/pull/99");
    expect(remoteBranches()).toContain("refs/heads/docs/plan-s3-2");
  });

  it("continues to -3 when -2 has also merged", () => {
    writeFileSync(join(state, "docs_plan-s4"), "MERGED u1\n");
    writeFileSync(join(state, "docs_plan-s4-2"), "MERGED u2\n");
    expect(runBlock("s4", "SPEC-0003.md", "# T\n").branch).toBe("docs/plan-s4-3");
  });

  it("still runs the secret-pattern scrub gate: matching content is never committed or pushed", () => {
    const r = runBlock(
      "s5",
      "SPEC-0001.md",
      `# Spec\nkey ${["AKIA", "ABCDEFGHIJKLMNOP"].join("")}\n`,
    );
    expect(r.out).toContain("matched a secret-pattern scan");
    expect(r.url).toBe("");
    expect(remoteBranches()).not.toContain("docs/plan-s5");
    expect(existsCreated()).toBe(false);
  });
});

function existsCreated(): boolean {
  return Bun.spawnSync(["test", "-f", join(state, "created")]).exitCode === 0;
}
