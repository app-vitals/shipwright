/**
 * Regression guard for the broken one-step install command (CRQ-2.1).
 *
 * `/plugin install shipwright@app-vitals/shipwright` does not work: the
 * `@` suffix must be a marketplace name, not a GitHub repo. The working form
 * is the two-step `/plugin marketplace add app-vitals/shipwright` then
 * `/plugin install shipwright@shipwright`. No other layer scans static site
 * copy, so this test walks site/ and fails if the broken form reappears.
 *
 * The pattern is built from parts so this file does not contain the literal.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const siteRoot = resolve(import.meta.dir, "site");
const SKIP_DIRS = new Set(["node_modules", "dist", ".astro"]);
const TEXT_EXT = /\.(astro|ts|tsx|js|mjs|json|md|mdx|html|css|txt|ya?ml)$/;
const broken = ["shipwright", "app-vitals/shipwright"].join("@");

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (TEXT_EXT.test(name)) yield full;
  }
}

describe("site install command", () => {
  it("never uses the non-working one-step install form", () => {
    const offenders = [...walk(siteRoot)].filter((f) =>
      readFileSync(f, "utf8").includes(broken),
    );
    expect(offenders).toEqual([]);
  });

  it("consts.ts defines the two-step install command", () => {
    const src = readFileSync(join(siteRoot, "src/consts.ts"), "utf8");
    expect(src).toContain("/plugin marketplace add app-vitals/shipwright");
    expect(src).toContain("/plugin install shipwright@shipwright");
  });
});
