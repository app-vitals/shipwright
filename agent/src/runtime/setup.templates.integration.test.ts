/**
 * ARD-6.1 — type-aware workspace templates.
 *
 * Real temp dirs, no mocks: seeds workspaces via ensureAgentHome() and
 * compares the written bytes against the template directory.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ensureAgentHome, resolveTemplatesDir } from "./setup.ts";

// Beside the runtime source in the extracted layout, two levels up in the monorepo.
const CODING_TEMPLATES = [
  join(import.meta.dir, "workspace"),
  join(import.meta.dir, "..", "..", "workspace"),
].find((dir) => existsSync(dir)) as string;

// seeded file -> template it comes from
const SEEDED: Record<string, string> = {
  "CLAUDE.md": "CLAUDE.md.template",
  "VOICE.md": "VOICE.md.template",
  "SOUL.md": "SOUL.md.template",
  "IDENTITY.md": "IDENTITY.md.template",
  "mise.toml": "mise.toml.template",
  "requirements.txt": "requirements.txt.template",
  "BOOTSTRAP.md": "BOOTSTRAP.md.template",
};

let root: string;
let home: string;

beforeEach(() => {
  root = `/tmp/test-ard61-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fake repo root with one specialty whose templatesDir is `templatesDir`. */
function fakeRepo(typeName: string, templatesDir: string): string {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "specialties", typeName), { recursive: true });
  writeFileSync(
    join(repo, "specialties", typeName, "manifest.yaml"),
    `apiVersion: shipwright.dev/v1alpha1\nkind: Specialty\nidentity:\n  templatesDir: ${templatesDir}\n`,
  );
  return repo;
}

function writeTemplates(dir: string, marker: string): void {
  mkdirSync(dir, { recursive: true });
  for (const template of Object.values(SEEDED)) {
    writeFileSync(join(dir, template), `${marker}:${template}\n`);
  }
}

describe("golden: coding agent seeds byte-identical files", () => {
  for (const typeName of [undefined, "coding"]) {
    it(`typeName=${typeName ?? "undefined"} seeds every file from the built-in workspace/`, () => {
      ensureAgentHome(home, typeName);
      for (const [file, template] of Object.entries(SEEDED)) {
        expect(
          readFileSync(join(home, "workspace", file)),
          `${file} differs from ${template}`,
        ).toEqual(readFileSync(join(CODING_TEMPLATES, template)));
      }
    });
  }
});

describe("specialist with a different templatesDir", () => {
  it("seeds that directory's files", () => {
    const repo = fakeRepo("specialist", "specialist-templates/");
    writeTemplates(join(repo, "specialist-templates"), "SPECIALIST");

    const dir = resolveTemplatesDir("specialist", repo, () => {});
    ensureAgentHome(home, "specialist", dir);

    for (const [file, template] of Object.entries(SEEDED)) {
      expect(readFileSync(join(home, "workspace", file), "utf8")).toBe(
        `SPECIALIST:${template}\n`,
      );
    }
  });
});

describe("resolveTemplatesDir fallback", () => {
  it("returns the coding templates for coding / undefined without warning", () => {
    const warnings: string[] = [];
    expect(resolveTemplatesDir("coding", root, (m) => warnings.push(m))).toBe(
      CODING_TEMPLATES,
    );
    expect(resolveTemplatesDir(undefined, root, (m) => warnings.push(m))).toBe(
      CODING_TEMPLATES,
    );
    expect(warnings).toEqual([]);
  });

  it("falls back with a warning for an unknown type", () => {
    const warnings: string[] = [];
    const dir = resolveTemplatesDir("nope", root, (m) => warnings.push(m));
    expect(dir).toBe(CODING_TEMPLATES);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"nope"');
  });

  it("falls back with a warning when templatesDir does not exist", () => {
    const repo = fakeRepo("ghost", "missing-dir/");
    const warnings: string[] = [];
    expect(resolveTemplatesDir("ghost", repo, (m) => warnings.push(m))).toBe(
      CODING_TEMPLATES,
    );
    expect(warnings).toHaveLength(1);
  });

  it("falls back with a warning when templatesDir lacks a required template", () => {
    const repo = fakeRepo("partial", "partial-templates/");
    writeTemplates(join(repo, "partial-templates"), "PARTIAL");
    rmSync(join(repo, "partial-templates", "SOUL.md.template"));
    const warnings: string[] = [];
    const dir = resolveTemplatesDir("partial", repo, (m) => warnings.push(m));
    expect(dir).toBe(CODING_TEMPLATES);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("SOUL.md.template");
    expect(() => ensureAgentHome(home, "partial", dir)).not.toThrow();
  });

  it("falls back with a warning on an unparseable manifest", () => {
    const repo = fakeRepo("broken", "x");
    writeFileSync(
      join(repo, "specialties", "broken", "manifest.yaml"),
      "identity: [unclosed",
    );
    const warnings: string[] = [];
    expect(resolveTemplatesDir("broken", repo, (m) => warnings.push(m))).toBe(
      CODING_TEMPLATES,
    );
    expect(warnings).toHaveLength(1);
  });

  it("ensureAgentHome never fails boot for an unresolvable type", () => {
    expect(() => ensureAgentHome(home, "does-not-exist")).not.toThrow();
    expect(
      readFileSync(join(home, "workspace", "SOUL.md")).equals(
        readFileSync(join(CODING_TEMPLATES, "SOUL.md.template")),
      ),
    ).toBe(true);
  });
});

describe("existing workspaces are not rewritten", () => {
  it("keeps edited files when re-seeding under a different template dir", () => {
    ensureAgentHome(home, "coding");
    const soul = join(home, "workspace", "SOUL.md");
    writeFileSync(soul, "user edit\n");

    const altDir = join(root, "alt");
    writeTemplates(altDir, "ALT");
    ensureAgentHome(home, "specialist", altDir);

    expect(readFileSync(soul, "utf8")).toBe("user edit\n");
    expect(existsSync(join(home, "workspace", "IDENTITY.md"))).toBe(true);
    expect(
      readFileSync(join(home, "workspace", "IDENTITY.md"), "utf8"),
    ).not.toContain("ALT:");
  });
});
