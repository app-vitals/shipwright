/**
 * agent-lib-pin.content.test.ts
 *
 * AGR-4.5: the chat-notify, claim-ttl, default-account and http modules live in
 * the registry package @app-vitals/agent-lib (>= 0.1.1), not in a local lib/
 * workspace. Pins the root package.json and every consumer to that floor and
 * guards against the local copies or `@shipwright/lib` imports coming back.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = import.meta.dir;
const MIN = [0, 1, 1];
const MODULES = ["chat-notify", "claim-ttl", "default-account", "http"];
const CONSUMERS = [
  "package.json",
  "admin/package.json",
  "agent/package.json",
  "metrics/package.json",
  "task-store/package.json",
];

function parse(v: string): number[] {
  const m = /^\^?~?(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) throw new Error(`unparseable version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function atLeast(v: number[], min: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

function pkg(file: string): {
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(ROOT, file), "utf8"));
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "worktrees")
      continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("@app-vitals/agent-lib pin (AGR-4.5)", () => {
  for (const file of CONSUMERS) {
    it(`${file} pins @app-vitals/agent-lib >= 0.1.1`, () => {
      const p = pkg(file);
      const v =
        p.dependencies?.["@app-vitals/agent-lib"] ??
        p.devDependencies?.["@app-vitals/agent-lib"];
      expect(v, `${file} must depend on @app-vitals/agent-lib`).toBeDefined();
      expect(atLeast(parse(v as string), MIN)).toBe(true);
    });
  }

  it("the local lib workspace is gone", () => {
    expect(existsSync(join(ROOT, "lib"))).toBe(false);
    expect(pkg("package.json").workspaces).not.toContain("lib");
    for (const file of CONSUMERS) {
      expect(pkg(file).dependencies?.["@shipwright/lib"]).toBeUndefined();
    }
  });

  it("no source file imports @shipwright/lib/<migrated module>", () => {
    const re = new RegExp(`@shipwright/lib/(?:${MODULES.join("|")})\\b`);
    const self = join(ROOT, "agent-lib-pin.content.test.ts");
    const offenders = sourceFiles(ROOT)
      .filter((f) => f !== self && re.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("CET-1.1: task-store provisioning client and types are owned locally", () => {
    const re =
      /@app-vitals\/agent-(?:admin\/coding-task-store-provisioning-client|lib\/task-store-types)/;
    const self = join(ROOT, "agent-lib-pin.content.test.ts");
    const offenders = sourceFiles(ROOT)
      .filter((f) => f !== self && re.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
