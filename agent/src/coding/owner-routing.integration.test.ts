// Integration tests for the owner-hint requirement in
// scripts/bin/git-credential-shipwright.sh and scripts/bin/gh (GOR-1.4). Real
// subprocesses: the scripts' whole job is shell + process plumbing (stdin
// protocol, PATH stripping, exec), so fixtures/mocks would miss the behavior
// under test. The only stub is the real `gh` (a recording script) and a `bun`
// shim used to prove the wrapper never spawns bun.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dir, "..", "..", "scripts", "bin");
const HELPER = join(BIN, "git-credential-shipwright.sh");
const GH_WRAPPER = join(BIN, "gh");
const TEMPLATE_HELPER = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "scripts",
  "extract-platform",
  "template",
  "scripts",
  "bin",
  "git-credential-shipwright.sh",
);

let root: string;
let home: string;
let stubDir: string;

function writeExec(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** App auth: default token plus per-owner files. PAT auth: default token only. */
function setTokens(owners: Record<string, string> | null): void {
  writeFileSync(join(home, "gh-token"), "default-token");
  if (owners === null) return;
  mkdirSync(join(home, "gh-token.d"));
  for (const [owner, token] of Object.entries(owners)) {
    writeFileSync(join(home, "gh-token.d", owner), token);
  }
}

function runHelper(stdin: string, ownerHint?: string, helper = HELPER) {
  return spawnSync(helper, ["get"], {
    input: stdin,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      GH_TOKEN_FILE: join(home, "gh-token"),
      ...(ownerHint === undefined ? {} : { SHIPWRIGHT_GH_OWNER: ownerHint }),
    },
  });
}

function runGh(args: string[], ownerHint?: string, extraPath: string[] = []) {
  return spawnSync(GH_WRAPPER, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: [...extraPath, stubDir, "/usr/bin", "/bin"].join(":"),
      GH_TOKEN_FILE: join(home, "gh-token"),
      ...(ownerHint === undefined ? {} : { SHIPWRIGHT_GH_OWNER: ownerHint }),
    },
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

describe("git-credential-shipwright.sh — owner hint", () => {
  const stdin = "protocol=https\nhost=github.com\npath=other-org/repo.git\n\n";

  test("both copies are byte-identical", () => {
    expect(readFileSync(TEMPLATE_HELPER, "utf8")).toBe(
      readFileSync(HELPER, "utf8"),
    );
  });

  test("uses the hinted owner's token, case-insensitively, ignoring the request path", () => {
    setTokens({ acme: "acme-token", "other-org": "other-token" });
    for (const hint of ["acme", "ACME"]) {
      const r = runHelper(stdin, hint);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("password=acme-token\n");
    }
  });

  test("unset hint prints the teaching error to stderr and returns no credentials", () => {
    setTokens({ acme: "acme-token" });
    const r = runHelper(stdin);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("SHIPWRIGHT_GH_OWNER");
    expect(r.stderr).toContain("each org has its own token");
    expect(r.stderr).toContain("SHIPWRIGHT_GH_OWNER=<org> git");
    expect(r.stderr).toContain("shell state does not persist");
  });

  test("hint with no token file gets no credentials, never another owner's", () => {
    setTokens({ acme: "acme-token" });
    const r = runHelper(stdin, "stranger");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("stranger");
    expect(r.stderr).toContain("GitHub Installations card");
  });

  test("a path-traversal hint is rejected", () => {
    setTokens({ acme: "acme-token" });
    const r = runHelper(stdin, "../gh-token");
    expect(r.stdout).toBe("");
  });

  test("PAT mode (no gh-token.d) uses the single token and ignores the hint", () => {
    setTokens(null);
    for (const hint of [undefined, "acme"]) {
      const r = runHelper(stdin, hint);
      expect(r.stdout).toContain("password=default-token\n");
      expect(r.stderr).toBe("");
    }
  });
});

describe("gh wrapper — owner hint", () => {
  test("unset hint under app auth exits non-zero with the teaching error and does not run gh", () => {
    setTokens({ acme: "acme-token" });
    const r = runGh(["pr", "list", "-R", "acme/x"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("SHIPWRIGHT_GH_OWNER");
    expect(r.stderr).toContain("each org has its own token");
    expect(r.stderr).toContain("SHIPWRIGHT_GH_OWNER=<org> gh");
    expect(r.stderr).toContain("shell state does not persist");
  });

  test("hint with a matching file uses that owner's token, regardless of -R", () => {
    setTokens({ acme: "acme-token", "other-org": "other-token" });
    expect(runGh(["pr", "list", "-R", "acme/x"], "other-org").stdout).toContain(
      "TOKEN=other-token ARGS=pr list -R acme/x",
    );
    expect(runGh(["pr", "list"], "ACME").stdout).toContain("TOKEN=acme-token");
  });

  test("hint with no token file fails naming the org and points at the Installations card", () => {
    setTokens({ acme: "acme-token" });
    const r = runGh(["pr", "list"], "stranger");
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("stranger");
    expect(r.stderr).toContain("installation is missing, broken or not in");
    expect(r.stderr).toContain("GitHub Installations card");
  });

  test("hint with no token file never falls back to the default token", () => {
    setTokens(null);
    const r = runGh(["pr", "list"], "acme");
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("default-token");
  });

  test("PAT mode passes through with the hint ignored", () => {
    // No GH_TOKEN_FILE at all: the wrapper must not touch GH_TOKEN.
    const r = spawnSync(GH_WRAPPER, ["pr", "list"], {
      encoding: "utf8",
      env: {
        PATH: `${stubDir}:/usr/bin:/bin`,
        SHIPWRIGHT_GH_OWNER: "acme",
        GH_TOKEN: "pat-token",
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("TOKEN=pat-token");
    expect(r.stderr).toBe("");
  });

  test("spawns no bun process", () => {
    setTokens({ acme: "acme-token" });
    const marker = join(root, "bun-invoked");
    const shimDir = join(root, "shim");
    mkdirSync(shimDir);
    writeExec(join(shimDir, "bun"), `#!/usr/bin/env bash\ntouch ${marker}\n`);
    const r = runGh(["pr", "list", "-R", "acme/x"], "acme", [shimDir]);
    expect(r.stdout).toContain("TOKEN=acme-token");
    expect(existsSync(marker)).toBe(false);
  });
});
