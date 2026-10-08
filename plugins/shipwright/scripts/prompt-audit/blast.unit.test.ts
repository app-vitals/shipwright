/**
 * plugins/shipwright/scripts/prompt-audit/blast.unit.test.ts
 *
 * Runs blastRadius against a temp-dir mini repo using injected fs deps.
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
import { blastRadius, parseManifestCrons } from "./blast.ts";
import type { InventoryDeps } from "./inventory.ts";

const MANIFEST = [
  "apiVersion: shipwright.dev/v1alpha1",
  "crons:",
  "  - name: shipwright-dev-task",
  '    schedule: "* * * * *"',
  "    prompt: /shipwright:dev-task",
  "    parentCron: shipwright-loop",
  "  - name: patrol",
  "    prompt: |-",
  "      /shipwright:scan",
  "      then write state.",
  "    silent: true",
  "  - name: shipwright-loop",
  "    prompt: internal",
  "",
].join("\n");

const FIXTURE: Record<string, string> = {
  "CLAUDE.md": "# Root\n\nRun `/shipwright:dev-task` for work. @docs/shared.md\n",
  "docs/shared.md": "Shared notes.\n",
  "plugins/p/commands/dev-task.md": "---\ndescription: dev\n---\nBuild it.\n",
  "plugins/p/commands/dev-task.content.test.ts":
    'expect(content).toContain("Build it");\nconst x = 1;\n',
  "plugins/p/skills/helper/SKILL.md":
    "---\nname: helper\n---\nSee plugins/p/commands/dev-task.md for details.\n",
  "plugins/p/commands/scan.md": "---\ndescription: scan\n---\nScan.\n",
  "plugins/p/agents/reviewer.md":
    "---\nname: reviewer\ndescription: r\n---\nUses /shipwright:scan.\n",
  "plugins/p/commands/other.content.test.ts":
    'const f = "dev-task.md";\nexpect(readFile(f)).toMatch(/Build/);\n',
  "plugins/p/commands/lonely.md": "---\ndescription: nobody\n---\nAlone.\n",
  "agent-types/coding/manifest.yaml": MANIFEST,
  "site/docs-source-map.json": JSON.stringify({
    _comment: "x",
    "dev.mdx": ["plugins/p/commands/dev-task.md"],
    "all.mdx": ["plugins/p/commands/"],
    "unrelated.mdx": ["docs/shared.md"],
  }),
};

let root: string;
let deps: InventoryDeps;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "blast-"));
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
    listFiles: (r) => walk(r),
    readFile: (r, rel) => readFileSync(join(r, rel), "utf8"),
  };
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("blastRadius", () => {
  test("reports referrers, crons with loop phase, pinning tests, pages, load class", () => {
    const report = blastRadius("plugins/p/commands/dev-task.md", root, deps);

    expect(report.lowerBound).toBe(true);
    expect(report.note).toMatch(/lower bound/i);
    expect(report.referrers.map((r) => [r.path, r.via])).toEqual([
      ["CLAUDE.md", "invoke"],
      ["plugins/p/skills/helper/SKILL.md", "path"],
    ]);
    expect(report.referrers[1].kind).toBe("skill");
    expect(report.crons).toEqual([
      { name: "shipwright-dev-task", loopPhase: "dev-task" },
    ]);
    expect(report.pinningTests.map((t) => t.file)).toEqual([
      "plugins/p/commands/dev-task.content.test.ts",
      "plugins/p/commands/other.content.test.ts",
    ]);
    expect(report.pinningTests[0].assertions).toEqual([
      { line: 1, text: 'expect(content).toContain("Build it");' },
    ]);
    expect(report.sourceMapPages).toEqual(["all.mdx", "dev.mdx"]);
    expect(report.loadClass).toEqual({
      "local-dev": "on-invoke",
      "agent-runtime": "on-invoke",
    });
  });

  test("resolves @ imports as referrers and non-loop crons have no phase", () => {
    expect(
      blastRadius("docs/shared.md", root, deps).referrers.map((r) => [r.path, r.via]),
    ).toEqual([["CLAUDE.md", "import"]]);
    expect(
      blastRadius("plugins/p/commands/scan.md", root, deps).crons,
    ).toEqual([{ name: "patrol", loopPhase: null }]);
  });

  test("a file with no referrers yields an empty lower-bound report", () => {
    const report = blastRadius("plugins/p/commands/lonely.md", root, deps);
    expect(report.lowerBound).toBe(true);
    expect(report.referrers).toEqual([]);
    expect(report.crons).toEqual([]);
    expect(report.pinningTests).toEqual([]);
    expect(report.sourceMapPages).toEqual(["all.mdx"]);
    expect(report.note).toMatch(/lower bound/i);
  });

  test("an unknown file does not throw", () => {
    const report = blastRadius("nope/missing.md", root, deps);
    expect(report.loadClass).toBeNull();
    expect(report.referrers).toEqual([]);
  });
});

describe("parseManifestCrons", () => {
  test("handles inline and block prompts and parentCron", () => {
    expect(parseManifestCrons(MANIFEST)).toEqual([
      { name: "shipwright-dev-task", prompt: "/shipwright:dev-task", parentCron: "shipwright-loop" },
      { name: "patrol", prompt: "/shipwright:scan\nthen write state.", parentCron: null },
      { name: "shipwright-loop", prompt: "internal", parentCron: null },
    ]);
  });
});
