/**
 * scripts/check-platform-pin.unit.test.ts
 *
 * Runs the real script against a fake `gh` on PATH that replays recorded
 * outputs: pass, pending-no-release, pending-no-bump-pr, pending-bump-red,
 * plus version-compare edge cases.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "check-platform-pin.sh");
const PKG = "@app-vitals/agent-runtime";

const FAKE_GH = `#!/usr/bin/env bash
dir="$GH_FAKE_DIR"
case "$*" in
  "api -H"*) cat "$dir/package.json" ;;
  "api repos/"*"/releases/tags/"*)
    if [ -f "$dir/release" ]; then echo '{}'
    elif [ -f "$dir/release-error" ]; then echo "gh: HTTP 401: Bad credentials" >&2; exit 1
    else echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi ;;
  "api repos/"*"/pulls/"*) [ -f "$dir/pull.json" ] && cat "$dir/pull.json" || exit 1 ;;
  "api repos/"*"/releases?"*) [ -f "$dir/releases.json" ] && cat "$dir/releases.json" || exit 1 ;;
  "api repos/"*"/compare/"*)
    last="\${@: -1}"; tag="\${last##*...}"
    if [ -f "$dir/contains-$tag" ]; then echo '{"status":"ahead"}'; else echo '{"status":"diverged"}'; fi ;;
  "pr list"*) [ -f "$dir/prs-error" ] && exit 1; cat "$dir/prs.json" ;;
  *) echo "unexpected gh $*" >&2; exit 99 ;;
esac
`;

const FAKE_CURL = `#!/usr/bin/env bash
dir="$GH_FAKE_DIR"
[ -f "$dir/task-error" ] && exit 22
cat "$dir/task.json"
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pin-"));
  writeFileSync(join(dir, "gh"), FAKE_GH);
  chmodSync(join(dir, "gh"), 0o755);
  writeFileSync(join(dir, "curl"), FAKE_CURL);
  chmodSync(join(dir, "curl"), 0o755);
  writeFileSync(join(dir, "prs.json"), "[]");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(pinned: string, min: string, opts: { release?: boolean; prs?: unknown[] } = {}) {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ dependencies: { [PKG]: pinned } }),
  );
  if (opts.release) writeFileSync(join(dir, "release"), "");
  if (opts.prs) writeFileSync(join(dir, "prs.json"), JSON.stringify(opts.prs));
  const p = Bun.spawnSync(["bash", SCRIPT, PKG, min], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_FAKE_DIR: dir },
  });
  return { rc: p.exitCode, out: p.stdout.toString() };
}

describe("check-platform-pin.sh", () => {
  test("pass: pin equals or exceeds min", () => {
    expect(run("0.16.2", "0.16.2").rc).toBe(0);
    expect(run("^0.17.0", "0.16.2").rc).toBe(0);
    expect(run("1.0.0", "v0.16.2").rc).toBe(0);
  });

  test("compare is numeric, not lexical", () => {
    expect(run("0.9.0", "0.10.0", { release: true }).rc).toBe(1);
    expect(run("0.10.0", "0.9.0").rc).toBe(0);
  });

  test("prerelease pin is below its release", () => {
    expect(run("0.17.0-rc.1", "0.17.0", { release: true }).rc).toBe(1);
    expect(run("0.17.0", "0.17.0-rc.1").rc).toBe(0);
  });

  test("pending, no agent release", () => {
    const r = run("0.16.2", "0.16.3");
    expect(r.rc).toBe(1);
    expect(r.out).toContain("STAGE: no-agent-release");
  });

  test("pending, release published but no bump PR", () => {
    const r = run("0.16.2", "0.16.3", { release: true });
    expect(r.rc).toBe(1);
    expect(r.out).toContain("STAGE: no-bump-pr");
  });

  test("pending, bump PR red", () => {
    const r = run("0.16.2", "0.16.3", {
      release: true,
      prs: [
        {
          number: 1,
          url: "https://github.com/app-vitals/shipwright/pull/1",
          mergeable: "MERGEABLE",
          statusCheckRollup: [
            { conclusion: "SUCCESS" },
            { conclusion: "FAILURE" },
          ],
        },
      ],
    });
    expect(r.rc).toBe(1);
    expect(r.out).toContain("STAGE: bump-pr-red");
  });

  test("pending, bump PR conflicting and pending", () => {
    const pr = (mergeable: string, rollup: unknown[]) => [
      { number: 1, url: "u", mergeable, statusCheckRollup: rollup },
    ];
    expect(
      run("0.16.2", "0.16.3", { release: true, prs: pr("CONFLICTING", []) }).out,
    ).toContain("STAGE: bump-pr-conflicting");
    expect(
      run("0.16.2", "0.16.3", {
        release: true,
        prs: pr("MERGEABLE", [{ state: "PENDING" }]),
      }).out,
    ).toContain("STAGE: bump-pr-pending");
  });

  test("unpinned package exits 2", () => {
    writeFileSync(join(dir, "package.json"), "{}");
    const p = Bun.spawnSync(["bash", SCRIPT, PKG, "1.0.0"], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_FAKE_DIR: dir },
    });
    expect(p.exitCode).toBe(2);
  });

  test("missing argument exits 2", () => {
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_FAKE_DIR: dir };
    expect(Bun.spawnSync(["bash", SCRIPT], { env }).exitCode).toBe(2);
    expect(Bun.spawnSync(["bash", SCRIPT, PKG], { env }).exitCode).toBe(2);
  });

  test("non-404 release lookup failure exits 2, not no-agent-release", () => {
    writeFileSync(join(dir, "release-error"), "");
    const r = run("0.16.2", "0.16.3");
    expect(r.rc).toBe(2);
    expect(r.out).not.toContain("STAGE:");
  });

  test("gh pr list failure exits 2", () => {
    writeFileSync(join(dir, "prs-error"), "");
    expect(run("0.16.2", "0.16.3", { release: true }).rc).toBe(2);
  });
});

describe("check-platform-pin.sh --task", () => {
  const env = () => ({
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    GH_FAKE_DIR: dir,
    SHIPWRIGHT_TASK_STORE_URL: "http://store.test",
    SHIPWRIGHT_TASK_STORE_TOKEN: "t",
  });
  const releases = (...tags: string[]) =>
    JSON.stringify(tags.map((t) => ({ tag_name: t, draft: false, prerelease: false })));

  function runTask(
    pinned: string,
    opts: {
      task?: unknown;
      pull?: unknown;
      releases?: string;
      contains?: string[];
      release?: boolean;
      prs?: unknown[];
    } = {},
  ) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { [PKG]: pinned } }));
    writeFileSync(
      join(dir, "task.json"),
      JSON.stringify(opts.task ?? { id: "P-1", repo: "app-vitals/agent", pr: 7 }),
    );
    writeFileSync(
      join(dir, "pull.json"),
      JSON.stringify(opts.pull ?? { merged_at: "2026-01-01T00:00:00Z", merge_commit_sha: "abc1234" }),
    );
    writeFileSync(join(dir, "releases.json"), opts.releases ?? releases("v0.17.0", "v0.16.9"));
    for (const t of opts.contains ?? []) writeFileSync(join(dir, `contains-${t}`), "");
    if (opts.release) writeFileSync(join(dir, "release"), "");
    if (opts.prs) writeFileSync(join(dir, "prs.json"), JSON.stringify(opts.prs));
    const p = Bun.spawnSync(["bash", SCRIPT, "--task", "P-1", PKG], { env: env() });
    return { rc: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  }

  test("pass: pin >= first release containing the merge commit", () => {
    // v0.16.9 does not contain it; v0.17.0 and v0.17.1 do — first is v0.17.0.
    const r = runTask("0.17.0", {
      releases: releases("v0.17.1", "v0.16.9", "v0.17.0"),
      contains: ["v0.17.0", "v0.17.1"],
    });
    expect(r.rc).toBe(0);
    expect(r.out).toContain("first shipped in v0.17.0");
  });

  test("pin below the first containing release is not yet", () => {
    const r = runTask("0.16.9", {
      contains: ["v0.17.0"],
      release: true,
    });
    expect(r.rc).toBe(1);
    expect(r.out).toContain("STAGE: no-bump-pr");
  });

  test("producer not merged", () => {
    const r = runTask("0.16.0", { pull: { merged_at: null, merge_commit_sha: null } });
    expect(r.rc).toBe(1);
    expect(r.out).toContain("STAGE: producer-not-merged");
  });

  test("merged but no release contains the commit", () => {
    const r = runTask("0.16.0");
    expect(r.rc).toBe(1);
    expect(r.out).toContain("STAGE: no-agent-release");
  });

  test("prereleases and drafts are ignored", () => {
    const r = runTask("0.18.0", {
      releases: JSON.stringify([
        { tag_name: "v0.17.0", draft: false, prerelease: true },
        { tag_name: "v0.17.1", draft: true, prerelease: false },
      ]),
      contains: ["v0.17.0", "v0.17.1"],
    });
    expect(r.rc).toBe(1);
    expect(r.out).toContain("STAGE: no-agent-release");
  });

  test("task with no pr exits 2", () => {
    expect(runTask("0.16.0", { task: { id: "P-1", repo: "app-vitals/agent", pr: null } }).rc).toBe(2);
    expect(runTask("0.16.0", { task: { id: "P-1", pr: 7 } }).rc).toBe(2);
  });

  test("task-store failure exits 2", () => {
    writeFileSync(join(dir, "task-error"), "");
    expect(runTask("0.16.0").rc).toBe(2);
  });

  test("gh failure reading the PR exits 2", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { [PKG]: "0.16.0" } }));
    writeFileSync(join(dir, "task.json"), JSON.stringify({ repo: "app-vitals/agent", pr: 7 }));
    const p = Bun.spawnSync(["bash", SCRIPT, "--task", "P-1", PKG], { env: env() });
    expect(p.exitCode).toBe(2);
  });

  test("missing task-store env exits 2", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { [PKG]: "0.16.0" } }));
    const e: Record<string, string | undefined> = { ...env() };
    delete e.SHIPWRIGHT_TASK_STORE_TOKEN;
    expect(Bun.spawnSync(["bash", SCRIPT, "--task", "P-1", PKG], { env: e }).exitCode).toBe(2);
  });

  test("wrong arg count exits 2", () => {
    expect(Bun.spawnSync(["bash", SCRIPT, "--task", "P-1"], { env: env() }).exitCode).toBe(2);
  });
});
