import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Behaviour tests for plan-session.md (PLU-4.3): the Step 6d docs-PR shell block
 * (run against a real local git repo + bare origin, `gh` shimmed) and the
 * Step 0.7 planning-lock functions (run with a `curl` shim).
 */

const MD = readFileSync(join(import.meta.dir, "plan-session.md"), "utf-8");

function extractBlock(marker: string): string {
  const start = MD.indexOf(`\`\`\`bash\n# ${marker}`);
  expect(start).toBeGreaterThan(-1);
  const bodyStart = start + "```bash\n".length;
  return MD.slice(bodyStart, MD.indexOf("\n```", bodyStart));
}

const GH_SHIM = `#!/bin/bash
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

// curl shim: logs "METHOD URL", answers with $CURL_CODE and body $CURL_BODY.
const CURL_SHIM = `#!/bin/bash
OUT=""; M="GET"
while [ $# -gt 0 ]; do
  case "$1" in -o) OUT="$2"; shift ;; -X) M="$2"; shift ;; -w) shift ;; http*) U="$1" ;; esac
  shift
done
echo "$M $U" >> "$CURL_LOG"
[ -n "$OUT" ] && [ "$OUT" != /dev/null ] && printf '%s' "$CURL_BODY" > "$OUT"
printf '%s' "$CURL_CODE"
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
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function runPlanPr(session: string, files: Record<string, string>) {
  mkdirSync(join(work, "planning", session), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(work, "planning", session, name), body);
  const script = extractBlock("plan-docs-pr").replace('SESSION="{session}"', `SESSION="${session}"`);
  const r = sh(script, work, { PATH: `${join(dir, "bin")}:${process.env.PATH}`, GH_STATE: state });
  expect(r.code).toBe(0);
  const field = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(r.out)?.[1] ?? "";
  return { ...r, branch: field("PLAN_PR_BRANCH"), url: field("PLAN_PR_URL") };
}

const remoteTree = (branch: string) => sh(`git --git-dir=${origin} ls-tree -r --name-only ${branch}`, dir).out;
const remoteFile = (branch: string, path: string) => sh(`git --git-dir=${origin} show ${branch}:${path}`, dir).out;
const created = () => {
  try {
    return readFileSync(join(state, "created"), "utf-8").trim().split("\n");
  } catch {
    return [];
  }
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plan-docs-pr-"));
  origin = join(dir, "origin.git");
  work = join(dir, "work");
  state = join(dir, "state");
  mkdirSync(state);
  mkdirSync(join(dir, "bin"));
  for (const [n, body] of [["gh", GH_SHIM], ["curl", CURL_SHIM]] as const) {
    writeFileSync(join(dir, "bin", n), body);
    chmodSync(join(dir, "bin", n), 0o755);
  }
  const env = "export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com";
  sh(`${env}; git init -q --bare -b main ${origin}`, dir);
  sh(
    `${env}; git clone -q ${origin} work && cd work && git checkout -q -b main && echo x > README.md && echo planning/ > .gitignore && git add README.md .gitignore && git commit -q -m init && git push -q -u origin main && git remote set-head origin main`,
    dir,
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("plan-session.md Step 6d docs PR block (behaviour)", () => {
  it("first pass opens docs/plan-{session}, force-adding PLAN.md despite .gitignore", () => {
    const r = runPlanPr("p1", { "PLAN.md": "# Plan\n## Pass 1\n" });
    expect(r.branch).toBe("docs/plan-p1");
    expect(r.url).toBe("https://github.com/o/r/pull/99");
    expect(remoteTree("docs/plan-p1")).toContain("planning/p1/PLAN.md");
    expect(readFileSync(join(work, ".gitignore"), "utf-8")).toBe("planning/\n");
  });

  it("second pass commits the updated PLAN.md to the open PR branch instead of skipping", () => {
    runPlanPr("p2", { "PLAN.md": "# Plan\n\n## Pass 1\nfirst\n" });
    writeFileSync(join(state, "docs_plan-p2"), "OPEN https://github.com/o/r/pull/7\n");
    const r = runPlanPr("p2", { "PLAN.md": "# Plan\n\n## Pass 1\nfirst\n\n## Pass 2\nsecond\n" });
    expect(r.branch).toBe("docs/plan-p2");
    expect(r.url).toBe("https://github.com/o/r/pull/7");
    const body = remoteFile("docs/plan-p2", "planning/p2/PLAN.md");
    expect(body).toContain("## Pass 2");
    expect(body.indexOf("first")).toBeLessThan(body.indexOf("second"));
    expect(created()).toEqual(["docs/plan-p2"]); // no second PR opened
    expect(sh(`git --git-dir=${origin} log --format=%s docs/plan-p2`, dir).out).toContain("update p2 plan");
  });

  it("opens docs/plan-{session}-2 when the earlier PR has merged", () => {
    writeFileSync(join(state, "docs_plan-p3"), "MERGED https://github.com/o/r/pull/5\n");
    const r = runPlanPr("p3", { "PLAN.md": "# Plan\n## Pass 2\n" });
    expect(r.branch).toBe("docs/plan-p3-2");
    expect(r.url).toBe("https://github.com/o/r/pull/99");
    expect(remoteTree("docs/plan-p3-2")).toContain("planning/p3/PLAN.md");
  });

  it("also carries the session's spec files", () => {
    runPlanPr("p4", { "PLAN.md": "# P\n", "PRODUCT-SPEC.md": "# S1\n", "SPEC-0002.md": "# S2\n" });
    const tree = remoteTree("docs/plan-p4");
    expect(tree).toContain("planning/p4/PRODUCT-SPEC.md");
    expect(tree).toContain("planning/p4/SPEC-0002.md");
  });

  it("still runs the secret-pattern scrub gate: matching content is never committed or pushed", () => {
    const r = runPlanPr("p5", { "PLAN.md": `# P\nkey ${["AKIA", "ABCDEFGHIJKLMNOP"].join("")}\n` });
    expect(r.out).toContain("matched a secret-pattern scan");
    expect(r.url).toBe("");
    expect(sh(`git ls-remote --heads ${origin}`, dir).out).not.toContain("docs/plan-p5");
    expect(created()).toEqual([]);
  });
});

describe("plan-session.md Step 0.7 planning lock (behaviour)", () => {
  function runLock(call: string, code: string, body = "{}") {
    const script = `${extractBlock("plan-lock").replace('SESSION="{session}"', 'SESSION="s"')}\n${call}\necho "rc=$?"`;
    const log = join(dir, "curl.log");
    const r = sh(script, work, {
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      CURL_LOG: log,
      CURL_CODE: code,
      CURL_BODY: body,
      SHIPWRIGHT_TASK_STORE_URL: "http://store",
      SHIPWRIGHT_TASK_STORE_TOKEN: "t",
    });
    let calls = "";
    try {
      calls = readFileSync(log, "utf-8");
    } catch {}
    return { ...r, calls };
  }

  it("a held lock stops the pass and reports the holder and time", () => {
    const r = runLock(
      "plan_lock_acquire",
      "409",
      '{"holder":"agent-9","acquiredAt":"2026-11-17T10:00:00.000Z","expiresAt":"2026-11-17T10:15:00.000Z"}',
    );
    expect(r.out).toContain("PLAN_LOCK=held");
    expect(r.out).toContain("agent-9");
    expect(r.out).toContain("2026-11-17T10:00:00.000Z");
    expect(r.out).toContain("rc=1");
    expect(r.calls).not.toContain("DELETE");
  });

  it("acquires on 200, and a missing session row never blocks", () => {
    expect(runLock("plan_lock_acquire", "200").out).toContain("PLAN_LOCK=acquired");
    const r = runLock("plan_lock_acquire", "404");
    expect(r.out).toContain("rc=0");
  });

  it("releases the lock on a failure path via DELETE and never fails", () => {
    const r = runLock("plan_lock_acquire; false || plan_lock_release", "200");
    expect(r.calls).toContain("POST http://store/sessions/s/lock");
    expect(r.calls).toContain("DELETE http://store/sessions/s/lock");
    expect(r.out).toContain("PLAN_LOCK=released");
    expect(r.out).toContain("rc=0");
  });
});
