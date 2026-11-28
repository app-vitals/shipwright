/**
 * Patrol legacy-state sweep content test — PCR-6.1
 *
 * The four patrols (entropy, error, security, consolidation) moved their state into the task
 * store. The old agent-local files (`state/*-patrol-*.json`, `state/consolidation-ledger.json`)
 * are read exactly once per repo, by the import path in `scripts/cron-run-recorder.ts`.
 *
 * This test fails if any other plugin script, or any skill/command/agent/reference prose outside
 * an import description, still refers to those files. Markdown may mention them only inside a
 * paragraph that describes the one-time import (the paragraph says "import" or "legacy", which
 * is how skills pass `--legacy-shape` to the recorder). Scripts may not mention them at all.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const pluginRoot = resolve(import.meta.dir, "..");
const IMPORT_SCRIPT = "scripts/cron-run-recorder.ts";

const LEGACY =
  /(entropy-patrol-last-run|security-patrol-last-run|security-patrol-ledger|error-patrol-ledger|consolidation-ledger|state\/[\w-]*-patrol-[\w-]*\.json)/;

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const SCANNED_EXT = /\.(md|ts|sh|json|ya?ml|mjs|js)$/;
const IS_TEST = /\.(unit|integration|smoke|content)\.test\.ts$|\.test\.ts$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCANNED_EXT.test(name) && !IS_TEST.test(name)) out.push(full);
  }
  return out;
}

const files = walk(pluginRoot).filter(
  (f) => relative(pluginRoot, f) !== IMPORT_SCRIPT,
);

describe("patrol legacy state files are read only by the import script", () => {
  it("scans a non-trivial set of plugin files", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(readFileSync(join(pluginRoot, IMPORT_SCRIPT), "utf8")).toMatch(
      LEGACY,
    );
  });

  it("no plugin script outside the import script mentions a legacy patrol state file", () => {
    const offenders = files
      .filter((f) => !f.endsWith(".md"))
      .filter((f) => LEGACY.test(readFileSync(f, "utf8")))
      .map((f) => relative(pluginRoot, f));
    expect(offenders).toEqual([]);
  });

  it("markdown mentions a legacy patrol state file only inside an import description", () => {
    const offenders: string[] = [];
    for (const f of files.filter((p) => p.endsWith(".md"))) {
      const paragraphs = readFileSync(f, "utf8").split(/\n\s*\n/);
      for (const para of paragraphs) {
        if (LEGACY.test(para) && !/import|legacy/i.test(para)) {
          offenders.push(`${relative(pluginRoot, f)}: ${para.slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
