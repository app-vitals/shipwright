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
  "pr list"*) [ -f "$dir/prs-error" ] && exit 1; cat "$dir/prs.json" ;;
  *) echo "unexpected gh $*" >&2; exit 99 ;;
esac
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pin-"));
  writeFileSync(join(dir, "gh"), FAKE_GH);
  chmodSync(join(dir, "gh"), 0o755);
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
