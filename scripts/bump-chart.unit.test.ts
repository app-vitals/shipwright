/**
 * scripts/bump-chart.unit.test.ts
 * Unit tests for scripts/bump-chart.sh. The script is copied into a throwaway
 * fake repo (it resolves REPO_ROOT from its own location) and run with fake
 * git/yq/gh binaries on PATH, so nothing touches the real repo or network.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  existsSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SOURCE = resolve(process.cwd(), "scripts/bump-chart.sh");
const BASH = Bun.which("bash") ?? "bash";

interface Opts {
  version?: string;
  branch?: string;
  localBranchExists?: boolean;
  remoteBranchExists?: boolean;
  omit?: string[];
}

function setup(opts: Opts = {}) {
  const root = mkdtempSync(join(tmpdir(), "bump-chart-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "charts/shipwright"), { recursive: true });
  mkdirSync(join(root, "bin"));
  copyFileSync(SOURCE, join(root, "scripts/bump-chart.sh"));
  writeFileSync(
    join(root, "charts/shipwright/Chart.yaml"),
    `version: ${opts.version ?? "1.2.3"}\n`,
  );
  writeFileSync(
    join(root, "charts/shipwright/CHANGELOG.md"),
    "# Changelog\n\n## [1.2.3] - 2020-01-01\n\n### Changed\n\n- old\n",
  );
  const calls = join(root, "calls.log");
  const stub = (name: string, body: string) => {
    if (opts.omit?.includes(name)) return;
    writeFileSync(join(root, "bin", name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(root, "bin", name), 0o755);
  };
  stub(
    "yq",
    `if [ "$1" = "-i" ]; then echo "yq $*" >> "${calls}"; exit 0; fi
echo "${opts.version ?? "1.2.3"}"`,
  );
  stub("gh", `echo "gh $*" >> "${calls}"`);
  stub(
    "git",
    `echo "git $*" >> "${calls}"
case "$*" in
  *"branch --list"*) ${opts.localBranchExists ? 'echo "  found"' : "true"} ;;
  *ls-remote*) ${opts.remoteBranchExists ? 'echo "sha refs/heads/x"' : "true"} ;;
  *rev-parse*) echo "${opts.branch ?? "main"}" ;;
  *remote\\ get-url*) echo "git@github.com:org/repo.git" ;;
esac
exit 0`,
  );
  // Only bin + essential system dirs: tools not stubbed must be absent for `omit`.
  const sysBin = join(root, "sysbin");
  mkdirSync(sysBin);
  for (const t of ["bash", "sh", "python3", "mktemp", "date", "cat", "rm", "mv", "dirname", "grep", "sed"]) {
    const p = Bun.which(t);
    if (p) {
      try {
        symlinkSync(p, join(sysBin, t));
      } catch {}
    }
  }
  const run = (args: string[] = []) =>
    spawnSync(BASH, [join(root, "scripts/bump-chart.sh"), ...args], {
      encoding: "utf8",
      env: { HOME: root, PATH: `${join(root, "bin")}:${sysBin}` },
    });
  const log = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");
  return { root, run, log };
}

describe("scripts/bump-chart.sh version arithmetic (dry-run)", () => {
  test.each([
    [[], "1.2.4"],
    [["patch"], "1.2.4"],
    [["minor"], "1.3.0"],
    [["major"], "2.0.0"],
  ])("%j bumps 1.2.3 to %s", (args, expected) => {
    const { run } = setup();
    const r = run([...args, "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`new version      : ${expected}`);
    expect(r.stdout).toContain(`branch           : chore/chart-v${expected}`);
  });

  test("carries over from double-digit components", () => {
    const { run } = setup({ version: "0.9.19" });
    expect(run(["patch", "--dry-run"]).stdout).toContain("new version      : 0.9.20");
    expect(run(["minor", "--dry-run"]).stdout).toContain("new version      : 0.10.0");
  });
});

describe("scripts/bump-chart.sh arguments", () => {
  test("default message is derived from bump type and version", () => {
    const r = setup().run(["minor", "--dry-run"]);
    expect(r.stdout).toContain("minor: chart version bump to 1.3.0");
  });

  test("--message and -m set the message", () => {
    const { run } = setup();
    expect(run(["--message", "custom one", "--dry-run"]).stdout).toContain(
      "message          : custom one",
    );
    expect(run(["-m", "short", "--dry-run"]).stdout).toContain("message          : short");
  });

  test("--message without a value exits 1", () => {
    const r = setup().run(["--message"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--message requires a value");
  });

  test("unknown argument exits 1", () => {
    const r = setup().run(["--bogus"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown argument '--bogus'");
  });

  test("--help prints usage and exits 0", () => {
    const r = setup().run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--dry-run");
  });
});

describe("scripts/bump-chart.sh dry-run", () => {
  test("prints the plan and makes no writes or mutating calls", () => {
    const { root, run, log } = setup();
    const before = readFileSync(join(root, "charts/shipwright/Chart.yaml"), "utf8");
    const r = run(["--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DRY RUN");
    expect(readFileSync(join(root, "charts/shipwright/Chart.yaml"), "utf8")).toBe(before);
    expect(readFileSync(join(root, "charts/shipwright/CHANGELOG.md"), "utf8")).not.toContain("1.2.4");
    const calls = log();
    expect(calls).not.toMatch(/git .*(checkout|commit|push|add|pull)/);
    expect(calls).not.toContain("gh ");
    expect(calls).not.toContain("yq -i");
  });
});

describe("scripts/bump-chart.sh guards", () => {
  test("exits 0 when the branch already exists locally", () => {
    const r = setup({ localBranchExists: true }).run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already exists locally");
  });

  test("exits 0 when the branch already exists on the remote", () => {
    const { run, log } = setup({ remoteBranchExists: true });
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already exists on remote");
    expect(log()).not.toContain("gh ");
  });

  test("refuses to run off main", () => {
    const { run, log } = setup({ branch: "feat/x" });
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("must run from main (currently on feat/x)");
    expect(log()).not.toContain("yq -i");
  });

  test("fails when a required tool is missing", () => {
    const r = setup({ omit: ["yq"] }).run(["--dry-run"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("required tool 'yq' not found");
  });

  test("fails on an unparseable version", () => {
    const r = setup({ version: "1.2" }).run(["--dry-run"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Could not parse version");
  });
});

describe("scripts/bump-chart.sh full run (fake tools)", () => {
  test("updates changelog, branches, commits, pushes and opens a PR", () => {
    const { root, run, log } = setup();
    const r = run(["minor", "--message", "add thing"]);
    expect(r.status).toBe(0);
    const changelog = readFileSync(join(root, "charts/shipwright/CHANGELOG.md"), "utf8");
    expect(changelog).toMatch(/## \[1\.3\.0\] - \d{4}-\d{2}-\d{2}\n\n### Changed\n\n- add thing/);
    expect(changelog.indexOf("[1.3.0]")).toBeLessThan(changelog.indexOf("[1.2.3]"));
    const calls = log();
    expect(calls).toContain('yq -i .version = "1.3.0"');
    expect(calls).toContain("checkout -b chore/chart-v1.3.0");
    expect(calls).toContain("commit -m chore(chart): bump chart version to 1.3.0");
    expect(calls).toContain("push -u origin chore/chart-v1.3.0");
    expect(calls).toContain("gh pr create --repo org/repo --base main --head chore/chart-v1.3.0");
  });
});
