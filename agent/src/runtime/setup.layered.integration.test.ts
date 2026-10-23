/**
 * ARD-6.2 — layered workspace files (CLAUDE.md / RUNTIME.md / SPECIALTY.md).
 *
 * Real temp dirs, no mocks.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureAgentHome, resolveTemplatesDir } from "./setup.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const CODING_TEMPLATES = join(REPO_ROOT, "agent", "workspace");
const SPECIALIST_TEMPLATES = join(
  REPO_ROOT,
  "specialties",
  "specialist",
  "templates",
);

// Every heading of the pre-layering coding CLAUDE.md.template.
const OLD_CODING_HEADINGS = [
  "# Agent Identity",
  "## How You Work",
  "### Message Format",
  "### Clarifying Questions",
  "### Response Markers",
  "### Run Context",
  "## Workspace",
  "### Repos",
  "### Worktrees",
  "### Shipwright",
  "### Policy",
  "### Reviews",
  "### Dev Tools (mise)",
  "### Cron Jobs",
  "### Agent Configuration",
  "### Waiting and Polling",
];

function headings(markdown: string): string[] {
  let inFence = false;
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    else if (!inFence && /^#{1,6} /.test(line)) out.push(line.trimEnd());
  }
  return out;
}

const read = (dir: string, name: string) =>
  readFileSync(join(dir, name), "utf8");

let root: string;
let home: string;
let ws: string;

beforeEach(() => {
  root = `/tmp/test-ard62-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  home = join(root, "home");
  ws = join(home, "workspace");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("coding template split", () => {
  it("keeps every old heading in exactly one of CLAUDE, RUNTIME, SPECIALTY", () => {
    const all = ["CLAUDE", "RUNTIME", "SPECIALTY"].flatMap((n) =>
      headings(read(CODING_TEMPLATES, `${n}.md.template`)),
    );
    for (const heading of OLD_CODING_HEADINGS) {
      expect(
        all.filter((h) => h === heading),
        heading,
      ).toHaveLength(1);
    }
  });

  it("includes in the shared order", () => {
    const includes = read(CODING_TEMPLATES, "CLAUDE.md.template")
      .split("\n")
      .filter((l) => l.startsWith("@"));
    expect(includes).toEqual([
      "@RUNTIME.md",
      "@SOUL.md",
      "@IDENTITY.md",
      "@BOOTSTRAP.md",
      "@SPECIALTY.md",
    ]);
  });

  it("seeds a new coding workspace with all three files", () => {
    ensureAgentHome(home, "coding");
    for (const n of ["CLAUDE", "RUNTIME", "SPECIALTY"]) {
      expect(read(ws, `${n}.md`)).toBe(
        read(CODING_TEMPLATES, `${n}.md.template`),
      );
    }
  });
});

describe("specialist template set", () => {
  it("has no Shipwright, Reviews or Policy sections", () => {
    for (const n of ["CLAUDE", "SOUL", "IDENTITY", "SPECIALTY"]) {
      const text = read(SPECIALIST_TEMPLATES, `${n}.md.template`);
      expect(
        headings(text).filter((h) => /Shipwright|Reviews|Policy/.test(h)),
      ).toEqual([]);
      expect(text).not.toContain("/shipwright:");
    }
  });

  it("keeps the shared include order including @SOUL.md", () => {
    expect(read(SPECIALIST_TEMPLATES, "CLAUDE.md.template")).toBe(
      read(CODING_TEMPLATES, "CLAUDE.md.template"),
    );
  });

  it("resolves from the manifest and seeds a workspace", () => {
    const dir = resolveTemplatesDir("specialist", REPO_ROOT, (m) => {
      throw new Error(m);
    });
    expect(dir).toBe(SPECIALIST_TEMPLATES);
    ensureAgentHome(home, "specialist", dir);
    expect(read(ws, "SPECIALTY.md")).toBe(read(dir, "SPECIALTY.md.template"));
    expect(read(ws, "RUNTIME.md")).toBe(
      read(CODING_TEMPLATES, "RUNTIME.md.template"),
    );
    // omitted templates fall back to the coding set
    expect(read(ws, "mise.toml")).toBe(
      read(CODING_TEMPLATES, "mise.toml.template"),
    );
  });
});

describe("boot ownership", () => {
  it("rewrites RUNTIME.md and SPECIALTY.md but never CLAUDE/SOUL/IDENTITY", () => {
    ensureAgentHome(home, "coding");
    for (const n of ["CLAUDE", "SOUL", "IDENTITY"])
      writeFileSync(join(ws, `${n}.md`), "mine\n");
    writeFileSync(join(ws, "RUNTIME.md"), "stale\n");
    writeFileSync(join(ws, "SPECIALTY.md"), "stale\n");

    ensureAgentHome(home, "coding");

    for (const n of ["CLAUDE", "SOUL", "IDENTITY"])
      expect(read(ws, `${n}.md`)).toBe("mine\n");
    expect(read(ws, "RUNTIME.md")).toBe(
      read(CODING_TEMPLATES, "RUNTIME.md.template"),
    );
    expect(read(ws, "SPECIALTY.md")).toBe(
      read(CODING_TEMPLATES, "SPECIALTY.md.template"),
    );
  });

  it("writes an empty SPECIALTY.md when the template dir provides none", () => {
    const dir = join(root, "tpl");
    mkdirSync(dir);
    for (const n of ["CLAUDE", "SOUL", "IDENTITY"])
      writeFileSync(join(dir, `${n}.md.template`), "x\n");
    ensureAgentHome(home, "custom", dir);
    expect(read(ws, "SPECIALTY.md")).toBe("");
  });

  it("leaves an existing coding workspace's seeded files byte-identical (golden)", () => {
    mkdirSync(ws, { recursive: true });
    const legacy = {
      "CLAUDE.md": "legacy claude\n@SOUL.md\n",
      "SOUL.md": "legacy soul\n",
      "IDENTITY.md": "legacy identity\n",
      "VOICE.md": "legacy voice\n",
    };
    for (const [f, c] of Object.entries(legacy)) writeFileSync(join(ws, f), c);
    ensureAgentHome(home, "coding");
    for (const [f, c] of Object.entries(legacy)) expect(read(ws, f)).toBe(c);
  });

  it("falls back to coding templates with a warning for an unresolvable specialty", () => {
    const warnings: string[] = [];
    const dir = resolveTemplatesDir("nope", root, (m) => warnings.push(m));
    expect(dir).toBe(CODING_TEMPLATES);
    expect(warnings).toHaveLength(1);
  });
});
