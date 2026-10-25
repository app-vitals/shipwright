/**
 * scripts/platform-docs-snapshot.integration.test.ts
 *
 * Runs the platform release receiver's steps (bump + docs snapshot, the same
 * commands platform-release.yml runs) against a fixture platform release in a
 * scratch repo, then feeds the resulting change set through the guard.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUMP_BRANCH, evaluate } from "./platform-docs-guard.ts";

const BUMP = join(import.meta.dir, "platform-release-bump.ts");
const SNAPSHOT = join(import.meta.dir, "platform-docs-snapshot.ts");

let root: string;
let release: string;

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return r.stdout.toString();
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pds-int-root-"));
  release = mkdtempSync(join(tmpdir(), "pds-int-release-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "x", dependencies: { "@app-vitals/agent-lib": "0.1.0" } }, null, 2) + "\n",
  );
  mkdirSync(join(root, "docs/platform"), { recursive: true });
  writeFileSync(join(root, "docs/platform/gone.md"), "stale\n");
  git(root, "init", "-q");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");

  // Fixture platform release v0.2.0
  mkdirSync(join(release, "docs"));
  writeFileSync(join(release, "docs/agent.md"), "# Agent\n");
  writeFileSync(join(release, "docs/specialties.md"), "# Specialties\n");
  writeFileSync(join(release, "docs/specialties.content.test.ts"), "// test\n");
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(release, { recursive: true, force: true });
});

describe("platform release receiver against a fixture release", () => {
  test("produces a bump containing the refreshed snapshot", () => {
    const bump = Bun.spawnSync(["bun", BUMP, "0.2.0", "--root", root]);
    expect(bump.exitCode).toBe(0);
    const snap = Bun.spawnSync(["bun", SNAPSHOT, "0.2.0", release, "--root", root]);
    expect(snap.exitCode, snap.stderr.toString()).toBe(0);

    git(root, "add", "-A");
    const changed = git(root, "diff", "--cached", "--name-only")
      .split("\n")
      .filter(Boolean);
    expect(changed).toEqual([
      "docs/platform/agent.md",
      "docs/platform/gone.md",
      "docs/platform/specialties.md",
      "package.json",
    ]);
    expect(readFileSync(join(root, "package.json"), "utf8")).toContain('"0.2.0"');

    const agent = readFileSync(join(root, "docs/platform/agent.md"), "utf8");
    expect(agent.split("\n")[0]).toContain("GENERATED");
    expect(agent).toContain(
      "https://github.com/app-vitals/agent/blob/v0.2.0/docs/agent.md",
    );
    expect(agent.endsWith("# Agent\n")).toBe(true);

    // The change set passes the guard from the bump branch, fails from any other.
    expect(evaluate(changed, BUMP_BRANCH).ok).toBe(true);
    expect(evaluate(changed, "feat/hand-edit").ok).toBe(false);
  });
});
