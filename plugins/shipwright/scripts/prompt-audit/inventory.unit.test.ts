/**
 * plugins/shipwright/scripts/prompt-audit/inventory.unit.test.ts
 *
 * Runs walkInventory against a temp-dir mini repo using real fs deps.
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
  extractImports,
  type InventoryDeps,
  type InventoryItem,
  parseFrontmatter,
  walkInventory,
} from "./inventory.ts";

const FIXTURE: Record<string, string> = {
  "CLAUDE.md": "# Root\n@docs/style.md\nSee `@not/an/import.md`.\n",
  "docs/style.md": "Style guide\n@deep1.md\n",
  "docs/deep1.md": "d1\n@deep2.md\n",
  "docs/deep2.md": "d2\n@deep3.md\n",
  "docs/deep3.md": "d3\n@deep4.md\n",
  "docs/deep4.md": "d4\n@deep5.md\n",
  "docs/deep5.md": "d5 (beyond 4 hops)\n",
  "docs/guide.md": "Just a doc\n",
  "pkg/CLAUDE.md": "# Nested\n",
  ".claude/rules/global.md": "Always on\n",
  ".claude/rules/scoped.md": "---\npaths:\n  - src/**/*.ts\n---\nScoped rule\n",
  ".claude/rules/inline.md": '---\npaths: ["a/**", "b/**"]\n---\nx\n',
  "plugins/p/skills/alpha/SKILL.md":
    "---\nname: alpha\ndescription: Does alpha things\n---\nline1\nline2\n",
  "plugins/p/skills/alpha-dup/SKILL.md":
    "---\nname: alpha\ndescription: >\n  Does alpha\n  things\n---\nstub\n",
  "plugins/p/commands/run.md": "---\ndescription: Run it\n---\nbody\n",
  "plugins/p/agents/rev.md": "---\nname: rev\ndescription: Reviews\n---\nbody\n",
  "plugins/p/references/ref.md": "reference\n",
  "plugins/p/scripts/thing.unit.test.ts": "ignored",
  "agent/workspace/CLAUDE.md.template": "# Agent\n@SOUL.md\n",
  "agent/workspace/SOUL.md.template": "Soul\n",
  "agent/workspace/mise.toml.template": "[tools]\n",
  "node_modules/x/CLAUDE.md": "skip me",
};

let root: string;
let items: InventoryItem[];
const get = (p: string) => {
  const item = items.find((i) => i.path === p);
  if (!item) throw new Error(`missing ${p}`);
  return item;
};

function listAll(dir: string, base = ""): string[] {
  return readdirSync(join(dir, base), { withFileTypes: true }).flatMap((e) => {
    const rel = base ? `${base}/${e.name}` : e.name;
    return e.isDirectory() ? listAll(dir, rel) : [rel];
  });
}

const deps: InventoryDeps = {
  listFiles: (r) => listAll(r),
  readFile: (r, p) => readFileSync(join(r, p), "utf8"),
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "prompt-audit-inv-"));
  for (const [rel, content] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  items = walkInventory(root, deps);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("walkInventory load classes", () => {
  test("local-dev: root CLAUDE.md and unscoped rules are always", () => {
    expect(get("CLAUDE.md").loadClass["local-dev"]).toBe("always");
    expect(get(".claude/rules/global.md").loadClass["local-dev"]).toBe("always");
  });

  test("rules with paths: are on-demand-path in both contexts", () => {
    for (const p of [".claude/rules/scoped.md", ".claude/rules/inline.md"]) {
      expect(get(p).kind).toBe("rule");
      expect(get(p).loadClass).toEqual({
        "local-dev": "on-demand-path",
        "agent-runtime": "on-demand-path",
      });
    }
    expect(get(".claude/rules/scoped.md").paths).toEqual(["src/**/*.ts"]);
    expect(get(".claude/rules/inline.md").paths).toEqual(["a/**", "b/**"]);
  });

  test("nested CLAUDE.md is on-demand-path locally", () => {
    expect(get("pkg/CLAUDE.md").loadClass["local-dev"]).toBe("on-demand-path");
  });

  test("agent-runtime: workspace template is the always file; root CLAUDE.md is not", () => {
    const tpl = get("agent/workspace/CLAUDE.md.template");
    expect(tpl.kind).toBe("claude-md");
    expect(tpl.loadClass["agent-runtime"]).toBe("always");
    expect(tpl.loadClass["local-dev"]).toBe("on-reference");
    expect(get("CLAUDE.md").loadClass["agent-runtime"]).toBe("on-reference");
  });

  test("skills and agents are listing; commands on-invoke; references on-reference", () => {
    expect(get("plugins/p/skills/alpha/SKILL.md").loadClass["local-dev"]).toBe("listing");
    expect(get("plugins/p/agents/rev.md").loadClass["agent-runtime"]).toBe("listing");
    expect(get("plugins/p/commands/run.md").loadClass["local-dev"]).toBe("on-invoke");
    expect(get("plugins/p/references/ref.md").kind).toBe("reference");
    expect(get("docs/guide.md").kind).toBe("doc");
    expect(get("agent/workspace/mise.toml.template").kind).toBe("template");
  });

  test("skips node_modules and test files", () => {
    expect(items.some((i) => i.path.startsWith("node_modules/"))).toBe(false);
    expect(items.some((i) => i.path.endsWith(".test.ts"))).toBe(false);
  });
});

describe("imports", () => {
  test("follows @ imports up to 4 hops, ignoring inline code", () => {
    for (const [p, depth] of [
      ["docs/style.md", 1],
      ["docs/deep1.md", 2],
      ["docs/deep2.md", 3],
      ["docs/deep3.md", 4],
    ] as const) {
      expect(get(p).kind).toBe("import");
      expect(get(p).loadClass["local-dev"]).toBe("always");
      expect(get(p).importDepth).toBe(depth);
    }
    expect(get("docs/deep4.md").loadClass["local-dev"]).not.toBe("always");
    expect(get("docs/deep4.md").kind).toBe("doc");
    expect(get("CLAUDE.md").imports).toEqual(["docs/style.md"]);
  });

  test("runtime template imports resolve to .template siblings and become always", () => {
    const soul = get("agent/workspace/SOUL.md.template");
    expect(soul.kind).toBe("import");
    expect(soul.loadClass["agent-runtime"]).toBe("always");
    expect(soul.loadClass["local-dev"]).toBe("on-reference");
  });

  test("extractImports skips fenced blocks", () => {
    expect(extractImports("@a.md\n```\n@b.md\n```\n@c.md")).toEqual(["a.md", "c.md"]);
  });
});

describe("metadata", () => {
  test("frontmatter name, description chars, body lines", () => {
    const a = get("plugins/p/skills/alpha/SKILL.md");
    expect(a.name).toBe("alpha");
    expect(a.description).toBe("Does alpha things");
    expect(a.descriptionChars).toBe(17);
    expect(a.bodyLines).toBe(2);
  });

  test("folded description on a duplicate stub matches the original", () => {
    const dup = get("plugins/p/skills/alpha-dup/SKILL.md");
    expect(dup.description).toBe(get("plugins/p/skills/alpha/SKILL.md").description);
  });

  test("parseFrontmatter tolerates files without frontmatter", () => {
    expect(parseFrontmatter("hello")).toEqual({ paths: [], body: "hello" });
  });
});
