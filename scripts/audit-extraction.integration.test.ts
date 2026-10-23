import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { auditTree, type Finding } from "./audit-extraction";

setDefaultTimeout(60_000);

const DRIVER = join(import.meta.dir, "audit-extraction.ts");
const IDENT = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

const MIT =
  "MIT License\n\nCopyright (c) 2026\n\nPermission is hereby granted, free of charge, to any person\n";
const PKG = `${JSON.stringify({ name: "fixture", license: "MIT" })}\n`;
// Assembled at runtime so no token-shaped literal lives in this source file.
const TOKEN = `ghp_${"aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6"}`;

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, ...IDENT },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!p.success) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function commitAll(root: string, msg: string): string {
  git(root, "add", "-A", "-f");
  git(root, "commit", "-q", "-m", msg);
  return git(root, "rev-parse", "HEAD");
}

function newRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  put(root, "LICENSE", MIT);
  put(root, "package.json", PKG);
  put(root, "src/index.ts", "export const x = 1;\n");
  commitAll(root, "initial");
}

function run(tree: string, ...args: string[]) {
  const p = Bun.spawnSync(["bun", DRIVER, tree, "--no-gitleaks", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: p.exitCode,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
  };
}

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "audit-it-"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("audit-extraction CLI", () => {
  test("clean fixture exits 0", () => {
    const tree = join(scratch, "clean");
    newRepo(tree);
    put(
      tree,
      "docs/a.md",
      "See https://chat.example.com and app-vitals/shipwright.\n",
    );
    commitAll(tree, "docs");
    const r = run(tree);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("AUDIT PASSED");
  });

  test("a secret committed then deleted is found in history (file + commit + rule), redacted", () => {
    const tree = join(scratch, "history-secret");
    newRepo(tree);
    put(tree, "config/deploy.env", `GITHUB_TOKEN=${TOKEN}\n`);
    const bad = commitAll(tree, "oops");
    rmSync(join(tree, "config"), { recursive: true });
    commitAll(tree, "remove it");

    const r = run(tree, "--report", join(scratch, "report.json"));
    expect(r.code).toBe(1);
    expect(r.out).toContain("secret/github-token");
    expect(r.out).toContain("config/deploy.env");
    expect(r.out).toContain(bad.slice(0, 12));
    expect(r.out).not.toContain(TOKEN);

    const report = JSON.parse(
      readFileSync(join(scratch, "report.json"), "utf8"),
    ) as {
      findings: Finding[];
    };
    const hit = report.findings.find((f) => f.rule === "secret/github-token");
    expect(hit).toMatchObject({
      file: "config/deploy.env",
      commit: bad,
      line: 1,
    });
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });

  test("--json prints machine-readable findings and still exits 1", () => {
    const tree = join(scratch, "json");
    newRepo(tree);
    put(tree, "src/a.ts", `const h = "db.prod.internal";\n`);
    commitAll(tree, "host");
    const r = run(tree, "--json");
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.out) as { findings: Finding[] };
    expect(parsed.findings.map((f) => f.rule)).toContain(
      "banned/internal-hostname",
    );
  });

  test("artifacts committed then removed are found in history", async () => {
    const tree = join(scratch, "artifacts");
    newRepo(tree);
    put(tree, "node_modules/dep/index.js", "module.exports = 1;\n");
    put(tree, ".env", "A=1\n");
    const bad = commitAll(tree, "add junk");
    git(tree, "rm", "-rq", "node_modules", ".env");
    git(tree, "commit", "-q", "-m", "rm junk");
    const { findings } = await auditTree({
      tree,
      historyBanned: false,
      useGitleaks: false,
    });
    const byRule = new Map(findings.map((f) => [f.rule, f]));
    expect(byRule.get("artifact/node_modules")).toMatchObject({ commit: bad });
    expect(byRule.get("artifact/env-file")).toMatchObject({
      file: ".env",
      commit: bad,
    });
  });

  test("banned strings in history are only reported with --history-banned", () => {
    const tree = join(scratch, "history-banned");
    newRepo(tree);
    put(tree, "notes.md", `deploy to ${["vitals", "os"].join("-")}\n`);
    commitAll(tree, "note");
    rmSync(join(tree, "notes.md"));
    commitAll(tree, "drop note");
    expect(run(tree).code).toBe(0);
    const r = run(tree, "--history-banned");
    expect(r.code).toBe(1);
    expect(r.out).toContain("banned/internal-product");
  });

  test("working-tree findings: banned string, missing license, planted artifact", () => {
    const tree = join(scratch, "wt");
    mkdirSync(tree);
    put(
      tree,
      "package.json",
      `${JSON.stringify({ name: "x", license: "ISC" })}\n`,
    );
    put(tree, "docs/a.md", "ping db.prod.internal\n");
    put(tree, "dist/out.js", "x\n");
    const r = run(tree);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no .git directory");
    for (const rule of [
      "banned/internal-hostname",
      "license/missing",
      "license/package-json",
      "artifact/build-output",
    ])
      expect(r.out).toContain(rule);
    expect(r.out).toContain("working-tree");
  });

  test("usage errors exit 2", () => {
    expect(run(join(scratch, "x"), "--bogus").code).toBe(2);
    expect(
      Bun.spawnSync(["bun", DRIVER], { stdout: "pipe", stderr: "pipe" })
        .exitCode,
    ).toBe(2);
    expect(run(join(scratch, "missing-tree")).code).toBe(2);
  });
});
