/**
 * plugin-script-imports.content.test.ts
 *
 * PII-1.2: every relative import under plugins/shipwright/scripts/ (non-test
 * files) must resolve to a file that is present in the agent image build
 * context (tracked, not excluded by .dockerignore, under plugins/ — the only
 * tree agent/Dockerfile copies into /app/plugins). A missing file then fails CI
 * here instead of failing a cron run.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { isExcluded, parseDockerignore } from "./dockerignore-context.ts";

const ROOT = import.meta.dir;
const SCRIPTS_DIR = "plugins/shipwright/scripts";
// Trees agent/Dockerfile copies into /app (scripts import agent/src/coding by relative path).
const IMAGE_TREES = ["plugins/", "agent/src/coding/"];
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", ".json"];
const transpiler = new Bun.Transpiler({ loader: "ts" });

const isTestFile = (f: string) => /\.(unit|integration|content|e2e)?\.?test\.[cm]?[jt]sx?$/.test(f);

/** Resolve a relative specifier against the set of files shipped in the image. */
function resolves(shipped: Set<string>, fromFile: string, spec: string): boolean {
  const base = posix.normalize(posix.join(dirname(fromFile), spec));
  if (base.startsWith("..")) return false;
  // Bun/TS allow `./x.js` to point at `./x.ts`.
  const stem = base.replace(/\.[cm]?js$/, "");
  const candidates = [
    ...EXTENSIONS.map((e) => base + e),
    ...(stem !== base ? [`${stem}.ts`, `${stem}.tsx`] : []),
    ...EXTENSIONS.slice(1).map((e) => `${base}/index${e}`),
  ];
  return candidates.some((c) => shipped.has(c));
}

/** Return `file -> spec` entries for relative imports that do not resolve. */
export function findUnresolvedImports(
  shipped: Set<string>,
  read: (file: string) => string,
): string[] {
  const missing: string[] = [];
  for (const file of shipped) {
    if (!file.startsWith(`${SCRIPTS_DIR}/`) || !/\.[cm]?tsx?$/.test(file)) continue;
    if (isTestFile(file)) continue;
    for (const imp of transpiler.scanImports(read(file).replace(/^#!.*/, ""))) {
      if (!imp.path.startsWith(".")) continue;
      if (!resolves(shipped, file, imp.path)) missing.push(`${file} -> ${imp.path}`);
    }
  }
  return missing.sort();
}

function shippedFiles(): Set<string> {
  const rules = parseDockerignore(readFileSync(join(ROOT, ".dockerignore"), "utf8"));
  const res = Bun.spawnSync(["git", "ls-files", ...IMAGE_TREES], { cwd: ROOT });
  const files = res.stdout.toString().split("\n").filter(Boolean);
  return new Set(files.filter((f) => !isExcluded(rules, f)));
}

describe("plugin scripts: relative imports resolve in the image context (PII-1.2)", () => {
  it("every relative import in non-test plugin scripts resolves", () => {
    const shipped = shippedFiles();
    expect(shipped.size).toBeGreaterThan(0);
    const unresolved = findUnresolvedImports(shipped, (f) =>
      readFileSync(join(ROOT, f), "utf8"),
    );
    expect(unresolved).toEqual([]);
  });

  it("reports an import whose target is missing from the context", () => {
    const files: Record<string, string> = {
      [`${SCRIPTS_DIR}/a.ts`]: 'import { x } from "./coverage/lcov.ts";\nimport "./b.ts";',
      [`${SCRIPTS_DIR}/b.ts`]: "export const b = 1;",
      [`${SCRIPTS_DIR}/a.unit.test.ts`]: 'import "./nope.ts";',
    };
    const unresolved = findUnresolvedImports(
      new Set(Object.keys(files)),
      (f) => files[f] as string,
    );
    expect(unresolved).toEqual([`${SCRIPTS_DIR}/a.ts -> ./coverage/lcov.ts`]);
  });

  it("fails against a context built without the PII-1.1 .dockerignore fix", () => {
    const broken = parseDockerignore("coverage\n**/coverage\n");
    const res = Bun.spawnSync(["git", "ls-files", ...IMAGE_TREES], { cwd: ROOT });
    const shipped = new Set(
      res.stdout.toString().split("\n").filter(Boolean).filter((f) => !isExcluded(broken, f)),
    );
    const unresolved = findUnresolvedImports(shipped, (f) =>
      readFileSync(join(ROOT, f), "utf8"),
    );
    expect(unresolved.some((u) => u.includes("/coverage"))).toBe(true);
  });
});
