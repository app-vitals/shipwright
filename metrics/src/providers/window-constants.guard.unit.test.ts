/**
 * metrics/src/providers/window-constants.guard.unit.test.ts
 * Guard (SCM-5.1): every metrics provider must derive its query window from
 * the request range, never from a hard-coded day-count constant
 * (`FOO_DAYS * DAY_MS`). Freshness markers are allowlisted explicitly.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Constants allowed to multiply DAY_MS (freshness markers, not windows). */
const ALLOWED_DAY_CONSTANTS = new Set(["COVERAGE_STALE_DAYS"]);

/** Return `NAME` for each `NAME_DAYS * DAY_MS` / `DAY_MS * NAME_DAYS` usage. */
function findHardCodedWindows(source: string): string[] {
  const found: string[] = [];
  const re =
    /\b([A-Z][A-Z0-9_]*_DAYS)\s*\*\s*(?:\w+\.)?DAY_MS\b|\b(?:\w+\.)?DAY_MS\s*\*\s*([A-Z][A-Z0-9_]*_DAYS)\b/g;
  for (const m of source.matchAll(re)) {
    const name = m[1] ?? m[2];
    if (name && !ALLOWED_DAY_CONSTANTS.has(name)) found.push(name);
  }
  return found;
}

describe("window-constants guard", () => {
  test("detector flags a hard-coded window and honors the allowlist", () => {
    expect(
      findHardCodedWindows("const s = now - TREND_DAYS * DAY_MS;"),
    ).toEqual(["TREND_DAYS"]);
    expect(findHardCodedWindows("DAY_MS * TREND_DAYS")).toEqual(["TREND_DAYS"]);
    expect(findHardCodedWindows("x > COVERAGE_STALE_DAYS * DAY_MS")).toEqual(
      [],
    );
  });

  test("no provider derives its window from a *_DAYS constant", () => {
    const dir = import.meta.dir;
    const files = readdirSync(dir).filter(
      (f) => f.endsWith(".ts") && !/\.test\.ts$/.test(f),
    );
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((f) =>
      findHardCodedWindows(readFileSync(join(dir, f), "utf8")).map(
        (n) => `${f}: ${n}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
