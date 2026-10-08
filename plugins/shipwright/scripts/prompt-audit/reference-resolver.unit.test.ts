/**
 * plugins/shipwright/scripts/prompt-audit/reference-resolver.unit.test.ts
 *
 * Runs the resolver against a temp-dir mini repo using injected fs deps.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  extractReferences,
  findOrphanedAutoSections,
  parseTaskNames,
  type ResolverDeps,
  resolveReferences,
} from "./reference-resolver.ts";

const FIXTURE: Record<string, string> = {
  "Taskfile.yml":
    "version: '3'\ntasks:\n  ci:\n    cmds: [x]\n  test:coverage:\n    cmds: [x]\n",
  "package.json": JSON.stringify({ scripts: { build: "x" } }),
  "src/real.ts": "const t = process.env.REAL_TOKEN;\n",
  "plugins/p/commands/scan.md":
    "---\nargument-hint: '[--dry-run]'\n---\nScan.\n",
  "plugins/p/skills/scan/SKILL.md": "---\nname: scan\n---\nbody\n",
  "docs/good.md":
    "See `src/real.ts` and `task ci`, `bun run build`.\nRun `/shipwright:scan --dry-run` with REAL_TOKEN via `REAL_TOKEN`.\nModel `claude-sonnet-5-5-20260101`.\n",
  "docs/bad.md": [
    "Uses claude-sonnet-4-5 here.",
    "Read `src/gone.ts` first.",
    "Run `task nope` or `bun run missing`.",
    "Try `/shipwright:scan --bogus` and `/shipwright:ghost`.",
    "Needs `GONE_SECRET_KEY`.",
    "Ignore {placeholder}/x.md and https://example.com/a.md and `src/*.ts`.",
  ].join("\n"),
  "CLAUDE.md":
    "# Root\n\n## Shipwright Learned Facts\n\n_auto-maintained by the learn skill_\n\n- a fact\n",
  "AGENTS.md": "# Agents\n\n## Live Section\n\n<!-- auto-maintained -->\n",
  "plugins/p/skills/learn/SKILL.md":
    "---\nname: learn\n---\nWrites into the Live Section of AGENTS.md.\n",
  "src/learn.unit.test.ts":
    "// mentions Shipwright Learned Facts only in a test\n",
  "planning/spec.md": "Shipwright Learned Facts is described here.\n",
};

const RATE_KEYS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"];

let root: string;
let deps: ResolverDeps;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "reference-resolver-"));
  for (const [rel, body] of Object.entries(FIXTURE)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  const walk = (dir: string, base = ""): string[] =>
    readdirSync(join(dir, base), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(dir, `${base}${e.name}/`) : [`${base}${e.name}`],
    );
  deps = {
    rateKeys: RATE_KEYS,
    listFiles: (r) => walk(r),
    readFile: (r, rel) => readFileSync(join(r, rel), "utf8"),
  };
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("extractReferences", () => {
  test("pulls paths, commands, flags, model ids and env vars; skips placeholders and urls", () => {
    const refs = extractReferences(FIXTURE["docs/bad.md"]);
    const keys = refs.map((r) => `${r.kind}:${r.value}`);
    expect(keys).toContain("path:src/gone.ts");
    expect(keys).toContain("command:task nope");
    expect(keys).toContain("command:bun run missing");
    expect(keys).toContain("flag:--bogus");
    expect(keys).toContain("model-id:claude-sonnet-4-5");
    expect(keys).toContain("env-var:GONE_SECRET_KEY");
    expect(
      keys.some((k) => k.includes("example.com") || k.includes("placeholder")),
    ).toBe(false);
    expect(keys.some((k) => k.includes("*"))).toBe(false);
  });

  test("records 1-based line numbers", () => {
    const ref = extractReferences(FIXTURE["docs/bad.md"]).find(
      (r) => r.value === "src/gone.ts",
    );
    expect(ref?.line).toBe(2);
  });
});

describe("parseTaskNames", () => {
  test("reads top-level task keys including colon names", () => {
    expect([...parseTaskNames(FIXTURE["Taskfile.yml"])].sort()).toEqual([
      "ci",
      "test:coverage",
    ]);
  });
});

describe("resolveReferences", () => {
  test("a doc whose references all resolve yields nothing", () => {
    expect(resolveReferences(root, deps, ["docs/good.md"])).toEqual([]);
  });

  test("reports the retired model id, unresolvable path, command, flag and env var", () => {
    const rules = resolveReferences(root, deps, ["docs/bad.md"]).map(
      (u) => `${u.rule}:${u.value}`,
    );
    expect(rules).toContain("retired-model-id:claude-sonnet-4-5");
    expect(rules).toContain("unresolvable-path:src/gone.ts");
    expect(rules).toContain("unresolvable-command:task nope");
    expect(rules).toContain("unresolvable-command:bun run missing");
    expect(rules).toContain("unresolvable-command:/shipwright:ghost");
    expect(rules).toContain("unknown-flag:--bogus");
    expect(rules).toContain("unresolvable-env-var:GONE_SECRET_KEY");
    expect(rules).toHaveLength(7);
  });

  test("defaults to scanning every inventoried prompt file", () => {
    const files = new Set(resolveReferences(root, deps).map((u) => u.file));
    expect(files.has("docs/bad.md")).toBe(true);
    expect(files.has("docs/good.md")).toBe(false);
  });
});

describe("findOrphanedAutoSections", () => {
  test("flags a banner with no writer outside tests and planning docs", () => {
    const orphans = findOrphanedAutoSections(root, deps);
    expect(orphans).toEqual([
      {
        file: "CLAUDE.md",
        line: 5,
        heading: "Shipwright Learned Facts",
        banner: "_auto-maintained by the learn skill_",
      },
    ]);
  });

  test("does not flag a section some other file writes to", () => {
    expect(
      findOrphanedAutoSections(root, deps).some((o) => o.file === "AGENTS.md"),
    ).toBe(false);
  });
});
