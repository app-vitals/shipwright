/**
 * AGR-1.9 — the platform seeds workspaces without any product specialty.
 *
 * Real temp dirs, no mocks. The fixture specialty under fixtures/specialties/
 * stands in for a product specialty; nothing here reads a coding template.
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

// Beside the runtime source in the extracted layout, one level up in the monorepo.
const FIXTURE_SPECIALTIES = [
  join(import.meta.dir, "fixtures", "specialties"),
  join(import.meta.dir, "..", "fixtures", "specialties"),
].find((dir) => existsSync(dir)) as string;
const FIXTURE_TEMPLATES = join(FIXTURE_SPECIALTIES, "fixture", "templates");
const ENV = {
  SHIPWRIGHT_SPECIALTIES_DIR: FIXTURE_SPECIALTIES,
  SHIPWRIGHT_DEFAULT_AGENT_TYPE: "fixture",
};

let root: string;
let home: string;
let ws: string;

beforeEach(() => {
  root = `/tmp/test-agr19-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  home = join(root, "home");
  ws = join(home, "workspace");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const read = (...p: string[]) => readFileSync(join(...p), "utf8");

describe("fixture specialty templates", () => {
  it("resolves the fixture templates from the manifest without a warning", () => {
    const warnings: string[] = [];
    const dir = resolveTemplatesDir(
      "fixture",
      root,
      (m) => warnings.push(m),
      ENV,
    );
    expect(dir).toBe(FIXTURE_TEMPLATES);
    expect(warnings).toEqual([]);
  });

  it("falls back to the configured default type when none is requested", () => {
    const dir = resolveTemplatesDir(undefined, root, () => {}, ENV);
    expect(dir).toBe(FIXTURE_TEMPLATES);
  });

  it("seeds a new workspace from the fixture templates", () => {
    const dir = resolveTemplatesDir("fixture", root, () => {}, ENV);
    ensureAgentHome(home, "fixture", dir);

    for (const name of ["CLAUDE", "SOUL", "IDENTITY"]) {
      expect(read(ws, `${name}.md`)).toBe(
        read(FIXTURE_TEMPLATES, `${name}.md.template`),
      );
    }
    expect(read(ws, "CLAUDE.md")).toContain("@SOUL.md");
    expect(existsSync(join(ws, "RUNTIME.md"))).toBe(true);
    expect(existsSync(join(ws, "state", "reviews"))).toBe(true);
  });

  it("never rewrites CLAUDE/SOUL/IDENTITY on a later boot but refreshes RUNTIME.md", () => {
    const dir = resolveTemplatesDir("fixture", root, () => {}, ENV);
    ensureAgentHome(home, "fixture", dir);
    for (const n of ["CLAUDE", "SOUL", "IDENTITY"])
      writeFileSync(join(ws, `${n}.md`), "mine\n");
    writeFileSync(join(ws, "RUNTIME.md"), "stale\n");

    ensureAgentHome(home, "fixture", dir);

    for (const n of ["CLAUDE", "SOUL", "IDENTITY"])
      expect(read(ws, `${n}.md`)).toBe("mine\n");
    expect(read(ws, "RUNTIME.md")).not.toBe("stale\n");
  });
});

describe("no default specialty configured", () => {
  it("names the env vars when the default specialty's templates cannot be found", () => {
    const emptyDir = join(root, "empty-templates");
    mkdirSync(emptyDir, { recursive: true });
    // An unresolvable default with no built-in templates to fall back to.
    let message = "";
    try {
      ensureAgentHome(home, "absent", emptyDir);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("Missing workspace template");
    expect(message).toContain("SHIPWRIGHT_SPECIALTIES_DIR");
    expect(message).toContain("SHIPWRIGHT_DEFAULT_AGENT_TYPE");
  });
});
