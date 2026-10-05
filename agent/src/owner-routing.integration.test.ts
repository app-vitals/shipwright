// Integration tests for owner-aware routing in scripts/bin/git-credential-shipwright.sh
// and scripts/bin/gh (MGI-3.2). Real subprocesses: the scripts' whole job is
// shell + process plumbing (stdin protocol, PATH stripping, exec), so
// fixtures/mocks would miss the behavior under test. The only stubs are the
// real `gh` (a recording script) and a `bun` shim used to prove no bun process
// is spawned on the single-installation path.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const BIN = join(import.meta.dir, "..", "scripts", "bin");
const HELPER = join(BIN, "git-credential-shipwright.sh");
const GH_WRAPPER = join(BIN, "gh");
const BUN_DIR = dirname(process.execPath);

let root: string;
let home: string;
let stubDir: string;

function writeExec(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function setTokens(owners: Record<string, string> | null): void {
  writeFileSync(join(home, "gh-token"), "default-token");
  if (owners === null) return;
  mkdirSync(join(home, "gh-token.d"));
  for (const [owner, token] of Object.entries(owners)) {
    writeFileSync(join(home, "gh-token.d", owner), token);
  }
}

function runHelper(stdin: string, tokenFile = join(home, "gh-token")) {
  return spawnSync(HELPER, ["get"], {
    input: stdin,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", GH_TOKEN_FILE: tokenFile },
  });
}

function git(cwd: string, ...args: string[]): void {
  spawnSync("git", args, { cwd });
}

function runGh(
  args: string[],
  opts: { cwd?: string; binInPath?: boolean } = {},
) {
  const path = [
    stubDir,
    ...(opts.binInPath === false ? [] : [BUN_DIR]),
    "/usr/bin",
    "/bin",
  ];
  return spawnSync(GH_WRAPPER, args, {
    cwd: opts.cwd ?? root,
    encoding: "utf8",
    env: { PATH: path.join(":"), GH_TOKEN_FILE: join(home, "gh-token") },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "owner-routing-"));
  home = join(root, "home");
  stubDir = join(root, "stub");
  mkdirSync(home);
  mkdirSync(stubDir);
  // Stub gh: records the token it was run with and its args.
  writeExec(
    join(stubDir, "gh"),
    '#!/usr/bin/env bash\necho "TOKEN=${GH_TOKEN:-} ARGS=$*"\n',
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("git-credential-shipwright.sh — owner routing", () => {
  const stdinFor = (path: string) =>
    `protocol=https\nhost=github.com\npath=${path}\n\n`;

  test("returns the matching owner's token, with and without .git", () => {
    setTokens({ acme: "acme-token", "other-org": "other-token" });
    for (const [path, want] of [
      ["acme/repo.git", "acme-token"],
      ["acme/repo", "acme-token"],
      ["other-org/thing.git", "other-token"],
      ["other-org/thing", "other-token"],
      ["ACME/Repo.git", "acme-token"],
    ] as const) {
      const r = runHelper(stdinFor(path));
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`password=${want}\n`);
    }
  });

  test("an owner with no token file gets no credentials, never another owner's", () => {
    setTokens({ acme: "acme-token", "other-org": "other-token" });
    const r = runHelper(stdinFor("stranger/repo.git"));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("stranger");
  });

  test("falls back to the default token when git sends no path", () => {
    setTokens({ acme: "acme-token", "other-org": "other-token" });
    const r = runHelper("protocol=https\nhost=github.com\n\n");
    expect(r.stdout).toContain("password=default-token\n");
  });
});

describe("gh wrapper — owner routing", () => {
  beforeEach(() =>
    setTokens({ acme: "acme-token", "other-org": "other-token" }),
  );

  test("-R selects the owner's token", () => {
    expect(runGh(["pr", "list", "-R", "other-org/x"]).stdout).toBe(
      "TOKEN=other-token ARGS=pr list -R other-org/x\n",
    );
    expect(runGh(["pr", "list", "--repo=acme/x"]).stdout).toContain(
      "TOKEN=acme-token",
    );
  });

  test("gh api repos/<owner>/... selects the owner's token", () => {
    expect(runGh(["api", "repos/other-org/x/issues"]).stdout).toContain(
      "TOKEN=other-token",
    );
  });

  test("cwd origin remote selects the owner for repo-scoped commands", () => {
    const repo = join(root, "checkout");
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "remote", "add", "origin", "https://github.com/other-org/x.git");
    expect(runGh(["pr", "status"], { cwd: repo }).stdout).toContain(
      "TOKEN=other-token",
    );
  });

  test("gh api graphql (no owner signal) uses the default token", () => {
    const repo = join(root, "checkout");
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "remote", "add", "origin", "https://github.com/other-org/x.git");
    expect(
      runGh(["api", "graphql", "-f", "query=x"], { cwd: repo }).stdout,
    ).toContain("TOKEN=default-token");
  });

  test("an owner with no token fails naming the org, without running gh", () => {
    const r = runGh(["pr", "list", "-R", "stranger/x"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("stranger");
    expect(r.stdout).toBe("");
  });
});

describe("single-installation behavior is unchanged", () => {
  const origScript = (name: string) => {
    const out = spawnSync(
      "git",
      ["show", `origin/main:agent/scripts/bin/${name}`],
      {
        cwd: import.meta.dir,
        encoding: "utf8",
      },
    );
    return out.status === 0 ? out.stdout : null;
  };

  test("helper output is byte-identical to the pre-routing script", () => {
    setTokens(null);
    const old = origScript("git-credential-shipwright.sh");
    if (old === null) return; // no origin/main ref (shallow checkout) — skip golden
    const oldPath = join(root, "old-helper.sh");
    writeExec(oldPath, old);
    const input = "protocol=https\nhost=github.com\npath=acme/repo.git\n\n";
    const run = (script: string) =>
      spawnSync(script, ["get"], {
        input,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          GH_TOKEN_FILE: join(home, "gh-token"),
        },
      });
    const [a, b] = [run(oldPath), run(HELPER)];
    expect(b.stdout).toBe(a.stdout);
    expect(b.stdout).toBe(
      "protocol=https\nhost=github.com\nusername=x-access-token\npassword=default-token\n",
    );
    expect(b.stderr).toBe(a.stderr);
    expect(b.status).toBe(a.status);
  });

  test("wrapper output is byte-identical to the pre-routing script", () => {
    setTokens(null);
    const old = origScript("gh");
    if (old === null) return;
    const oldDir = join(root, "old-bin");
    mkdirSync(oldDir);
    writeExec(join(oldDir, "gh"), old);
    const run = (wrapper: string) =>
      spawnSync(wrapper, ["pr", "list", "-R", "acme/x"], {
        encoding: "utf8",
        env: {
          PATH: `${stubDir}:/usr/bin:/bin`,
          GH_TOKEN_FILE: join(home, "gh-token"),
        },
      });
    const [a, b] = [run(join(oldDir, "gh")), run(GH_WRAPPER)];
    expect(b.stdout).toBe(a.stdout);
    expect(b.stdout).toBe("TOKEN=default-token ARGS=pr list -R acme/x\n");
    expect(b.status).toBe(a.status);
  });

  test("wrapper spawns no bun process when gh-token.d is absent", () => {
    setTokens(null);
    const marker = join(root, "bun-invoked");
    const shimDir = join(root, "shim");
    mkdirSync(shimDir);
    writeExec(join(shimDir, "bun"), `#!/usr/bin/env bash\ntouch ${marker}\n`);
    const r = spawnSync(GH_WRAPPER, ["pr", "list", "-R", "acme/x"], {
      encoding: "utf8",
      env: {
        PATH: `${shimDir}:${stubDir}:/usr/bin:/bin`,
        GH_TOKEN_FILE: join(home, "gh-token"),
      },
    });
    expect(r.stdout).toContain("TOKEN=default-token");
    expect(existsSync(marker)).toBe(false);
  });
});
