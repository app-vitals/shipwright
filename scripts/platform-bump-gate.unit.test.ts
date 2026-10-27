/**
 * scripts/platform-bump-gate.unit.test.ts
 *
 * Behavioral tests for the platform bump merge gate. The script runs for
 * real against a fake `gh` on PATH that replays a recorded timeline: each
 * `gh` subcommand has an ordered list of responses (the last one repeats),
 * and every call is logged so the tests can assert what was, and was not,
 * invoked. Intervals are zeroed through the script's env tunables.
 *
 * The scenarios are the #4580 / #4593 race (only the fast title check
 * registered, CI not yet started) and its neighbours.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "platform-bump-gate.sh");
const PR_URL = "https://github.com/app-vitals/shipwright/pull/4600";
const SHA = "abc123def456";

type Reply = { out?: string; err?: string; rc?: number };
type Timeline = Partial<Record<Key, Reply[]>>;
type Key =
  | "pr-view"
  | "run-list"
  | "run-watch"
  | "checks-count"
  | "checks-watch"
  | "checks-json"
  | "run-rerun"
  | "pr-merge";

// Maps a gh argv to a timeline key. Order matters: `pr checks` variants are
// told apart by their flags.
const FAKE_GH = `#!/usr/bin/env bash
dir="$GH_FAKE_DIR"
args="$*"
echo "$args" >> "$dir/calls.log"
case "$args" in
  "pr view"*) key=pr-view ;;
  "run list"*) key=run-list ;;
  "run watch"*) key=run-watch ;;
  "run rerun"*) key=run-rerun ;;
  "pr merge"*) key=pr-merge ;;
  "pr checks"*--watch*) key=checks-watch ;;
  "pr checks"*"--json name,state,link"*) key=checks-json ;;
  "pr checks"*) key=checks-count ;;
  *) echo "unexpected gh call: $args" >&2; exit 99 ;;
esac
n=$(( $(cat "$dir/$key.n" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$dir/$key.n"
total=$(cat "$dir/$key.total" 2>/dev/null || echo 0)
[ "$total" -eq 0 ] && exit 0
[ "$n" -gt "$total" ] && n=$total
[ -f "$dir/$key.$n.out" ] && cat "$dir/$key.$n.out"
[ -f "$dir/$key.$n.err" ] && cat "$dir/$key.$n.err" >&2
exit "$(cat "$dir/$key.$n.rc" 2>/dev/null || echo 0)"
`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bump-gate-"));
  writeFileSync(join(dir, "gh"), FAKE_GH);
  chmodSync(join(dir, "gh"), 0o755);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function record(timeline: Timeline) {
  for (const [key, replies] of Object.entries(timeline)) {
    writeFileSync(join(dir, `${key}.total`), String(replies.length));
    replies.forEach((r, i) => {
      const n = i + 1;
      if (r.out !== undefined) writeFileSync(join(dir, `${key}.${n}.out`), r.out);
      if (r.err !== undefined) writeFileSync(join(dir, `${key}.${n}.err`), r.err);
      writeFileSync(join(dir, `${key}.${n}.rc`), String(r.rc ?? 0));
    });
  }
}

function runGate(timeline: Timeline, env: Record<string, string> = {}) {
  record({ "pr-view": [{ out: `${SHA}\n` }], ...timeline });
  const proc = Bun.spawnSync(["bash", SCRIPT, PR_URL], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      GH_FAKE_DIR: dir,
      CI_WAIT_ATTEMPTS: "3",
      CI_WAIT_INTERVAL: "0",
      CHECK_REG_ATTEMPTS: "3",
      CHECK_REG_INTERVAL: "0",
      STALE_BASE_DELAY: "0",
      ...env,
    },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n");
  } catch {}
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
    calls,
    merged: calls.some((c) => c.startsWith("pr merge")),
    count: (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length,
  };
}

const runLink = (id: number) =>
  `https://github.com/app-vitals/shipwright/actions/runs/${id}/job/9`;
const checksJson = (...states: [string, string, number][]) =>
  JSON.stringify(
    states.map(([name, state, id]) => ({ name, state, link: runLink(id) })),
  );

describe("platform-bump-gate.sh", () => {
  test("only the fast title check registered and CI never started: does not merge", () => {
    // The #4580 / #4593 shape: the title check is green but no CI workflow
    // run exists for the head commit, so `gh pr checks` would look green.
    const r = runGate({
      "run-list": [{ out: "" }],
      "checks-count": [{ out: "1\n" }],
      "checks-watch": [{ rc: 0 }],
    });
    expect(r.code).toBe(1);
    expect(r.merged).toBe(false);
    expect(r.err).toContain("no CI workflow run appeared");
    // It never got as far as consulting the required checks.
    expect(r.count("pr checks")).toBe(0);
  });

  test("CI registers late: waits for the run, then the checks, then merges", () => {
    const r = runGate({
      "run-list": [{ out: "" }, { out: "" }, { out: "777\n" }],
      "checks-count": [{ out: "2\n" }],
      "checks-watch": [{ rc: 0 }],
      "pr-merge": [{ out: "merged\n" }],
    });
    expect(r.code).toBe(0);
    expect(r.count("run list")).toBe(3);
    const order = r.calls.map((c) => c.split(" ").slice(0, 2).join(" "));
    expect(order.indexOf("run watch")).toBeGreaterThan(order.lastIndexOf("run list"));
    expect(order.indexOf("pr merge")).toBeGreaterThan(order.indexOf("run watch"));
    expect(r.calls.find((c) => c.startsWith("run watch"))).toContain("777");
    expect(r.calls.find((c) => c.startsWith("run list"))).toContain(
      `--commit ${SHA} --workflow CI`,
    );
  });

  test("a required check keeps failing: exits nonzero after the attempts and never merges", () => {
    const r = runGate({
      "run-list": [{ out: "777\n" }],
      "checks-count": [{ out: "2\n" }],
      "checks-watch": [{ rc: 1 }],
      "checks-json": [
        {
          out: checksJson(["lint", "SUCCESS", 777], ["test", "FAILURE", 778]),
        },
      ],
    });
    expect(r.code).toBe(1);
    expect(r.merged).toBe(false);
    expect(r.err).toContain("exhausted 3 attempts");
    // Two reruns between three attempts, each of the failed run only.
    expect(r.count("run rerun")).toBe(2);
    expect(r.calls.filter((c) => c.startsWith("run rerun"))).toEqual([
      "run rerun 778 --failed",
      "run rerun 778 --failed",
    ]);
  });

  test("a failed check passes on rerun: merges", () => {
    const r = runGate({
      "run-list": [{ out: "777\n" }],
      "checks-count": [{ out: "1\n" }],
      "checks-watch": [{ rc: 1 }, { rc: 0 }],
      "checks-json": [{ out: checksJson(["test", "FAILURE", 778]) }],
      "pr-merge": [{ out: "merged\n" }],
    });
    expect(r.code).toBe(0);
    expect(r.count("run rerun")).toBe(1);
    expect(r.merged).toBe(true);
  });

  test("a failed check with no rerunnable run id: does not merge", () => {
    const r = runGate({
      "run-list": [{ out: "777\n" }],
      "checks-count": [{ out: "1\n" }],
      "checks-watch": [{ rc: 1 }],
      "checks-json": [{ out: "[]" }],
    });
    expect(r.code).toBe(1);
    expect(r.merged).toBe(false);
    expect(r.count("run rerun")).toBe(0);
  });

  test("required checks never register before the timeout: does not merge", () => {
    const r = runGate({
      "run-list": [{ out: "777\n" }],
      "checks-count": [{ out: "0\n" }],
    });
    expect(r.code).toBe(1);
    expect(r.merged).toBe(false);
    expect(r.err).toContain("no required checks registered");
    expect(r.count("pr checks")).toBe(3);
    expect(r.calls.some((c) => c.includes("--watch"))).toBe(false);
  });

  test("all required checks green: admin-squash-merges the PR", () => {
    const r = runGate({
      "run-list": [{ out: "777\n" }],
      "checks-count": [{ out: "3\n" }],
      "checks-watch": [{ rc: 0 }],
      "pr-merge": [{ out: "merged\n" }],
    });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`pr merge ${PR_URL} --squash --admin`);
    expect(r.count("run rerun")).toBe(0);
    expect(r.out).toContain(`Merged ${PR_URL}.`);
  });

  test("a failed CI run watch is ignored: the required checks decide", () => {
    const r = runGate({
      "run-list": [{ out: "777\n" }],
      "run-watch": [{ rc: 1 }],
      "checks-count": [{ out: "1\n" }],
      "checks-watch": [{ rc: 0 }],
    });
    expect(r.code).toBe(0);
    expect(r.merged).toBe(true);
  });

  test("a stale-base merge error is retried, then merges", () => {
    const r = runGate({
      "run-list": [{ out: "777\n" }],
      "checks-count": [{ out: "1\n" }],
      "pr-merge": [
        { err: "GraphQL: Base branch was modified. Review and try the merge again.\n", rc: 1 },
        { out: "merged\n" },
      ],
    });
    expect(r.code).toBe(0);
    expect(r.count("pr merge")).toBe(2);
  });

  test("any other merge failure is not retried", () => {
    const r = runGate({
      "run-list": [{ out: "777\n" }],
      "checks-count": [{ out: "1\n" }],
      "pr-merge": [{ err: "GraphQL: Pull request is not mergeable\n", rc: 1 }],
    });
    expect(r.code).toBe(1);
    expect(r.count("pr merge")).toBe(1);
  });

  test("requires a PR url argument", () => {
    const proc = Bun.spawnSync(["bash", SCRIPT], {
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr.toString()).toContain("usage");
  });
});
