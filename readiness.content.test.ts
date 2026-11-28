/**
 * RDY-1.1 content tests: docs/readiness.md must list exactly the catalogue's
 * checks, levels and owners, and no file added by the agent-readiness session
 * may name a competitor.
 *
 * Lives at the repo root because `bun test` never walks dot-directories.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { READINESS_CATALOGUE } from "./plugins/shipwright/scripts/readiness-catalogue.ts";

const ROOT = resolve(import.meta.dir);
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const ROW = /^\|\s*(\d)\s*\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*([a-z-]+)\s*\|$/;

describe("docs/readiness.md sync", () => {
  const rows = read("docs/readiness.md")
    .split("\n")
    .map((l) => ROW.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ level: Number(m[1]), id: m[2], title: m[3], owner: m[4] }));

  it("lists exactly the catalogue's checks, levels, titles and owners", () => {
    expect(rows).toEqual(READINESS_CATALOGUE.map((c) => ({ ...c })));
  });

  it("is listed in the CLAUDE.md Reference section", () => {
    expect(read("CLAUDE.md")).toContain("**docs/readiness.md**");
  });
});

// Assembled via concatenation so this file does not itself contain a name.
const BANNED = [
  "fact" + "ory\\.ai",
  "de" + "vin\\.ai",
  "cogni" + "tion\\.ai",
  "wind" + "surf",
  "code" + "ium",
  "tab" + "nine",
  "source" + "graph",
  "repl" + "it agent",
].map((p) => new RegExp(p, "i"));

// Files added by the agent-readiness session. Extend as later RDY tasks land.
const SESSION_PATHS = [
  "planning/agent-readiness",
  "docs/readiness.md",
  "readiness.content.test.ts",
  "plugins/shipwright/scripts/readiness-catalogue.ts",
  "plugins/shipwright/scripts/readiness-catalogue.unit.test.ts",
];

const walk = (rel: string): string[] =>
  statSync(join(ROOT, rel)).isDirectory()
    ? readdirSync(join(ROOT, rel)).flatMap((e) => walk(join(rel, e)))
    : [rel];

describe("no competitor names in agent-readiness files", () => {
  const files = SESSION_PATHS.flatMap(walk);

  it("scans the session's files", () => {
    expect(files.length).toBeGreaterThanOrEqual(SESSION_PATHS.length);
  });

  it("finds no banned word", () => {
    const hits = files.flatMap((f) =>
      read(f)
        .split("\n")
        .flatMap((line, i) => BANNED.filter((re) => re.test(line)).map(() => `${f}:${i + 1}`)),
    );
    expect(hits).toEqual([]);
  });
});
