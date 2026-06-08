#!/usr/bin/env bun
/**
 * Brand lint — fails on any hex color that isn't a Shipwright Harness token.
 *
 * This is the enforcement backstop: artifacts should use CSS variables from
 * brand.css (so they carry no raw hexes at all), but if a hardcoded color slips
 * in, this flags it. The allowlist is derived from brand/tokens.json, so it can
 * never drift from the brand system.
 *
 *   bun brand/brand-lint.ts <file...>   # exit 1 if any off-brand color found
 */

import tokens from "./tokens.json";

const HEX_RE = /#[0-9a-fA-F]{6}\b/g;

/** Pure: build the set of allowed (uppercased) hexes from tokens. Exported for tests. */
export function allowedHexes(t: typeof tokens = tokens): Set<string> {
  const set = new Set<string>(["#FFFFFF"]); // pure white is allowed text/ink
  for (const group of Object.values(t.color)) {
    if (typeof group !== "object") continue;
    for (const value of Object.values(group)) {
      for (const hex of String(value).match(HEX_RE) ?? []) set.add(hex.toUpperCase());
    }
  }
  for (const stops of Object.values(t.gradient)) {
    for (const hex of stops) set.add(hex.toUpperCase());
  }
  return set;
}

export interface LintResult {
  offBrandHexes: string[];
}

/** Pure: report any hex in `content` that isn't allowed. Exported for tests. */
export function lintBrand(content: string, allowed: Set<string> = allowedHexes()): LintResult {
  const found = content.match(HEX_RE) ?? [];
  const offBrandHexes = [...new Set(found.map((h) => h.toUpperCase()))].filter(
    (h) => !allowed.has(h),
  );
  return { offBrandHexes };
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: bun brand/brand-lint.ts <file...>");
    process.exit(2);
  }
  let failures = 0;
  for (const file of files) {
    const text = await Bun.file(file).text();
    const { offBrandHexes } = lintBrand(text);
    if (offBrandHexes.length > 0) {
      failures++;
      console.error(`✗ ${file}: off-brand colors → ${offBrandHexes.join(", ")}`);
    } else {
      console.log(`✓ ${file}: on-brand`);
    }
  }
  process.exit(failures > 0 ? 1 : 0);
}
