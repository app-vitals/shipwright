/**
 * metrics/src/dashboard/styles.unit.test.ts
 * Guards layout rules in styles.css that a browser-less test run cannot see
 * break: the info tooltips must not take up layout space while hidden.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

/** Body of the first rule whose selector list is exactly `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(
    new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`),
  );
  if (!match) throw new Error(`rule not found: ${selector}`);
  return match[1];
}

describe("dashboard tooltips", () => {
  it("are not rendered while hidden, so they cannot widen the page", () => {
    const hidden = ruleBody("[data-tooltip]::after");
    expect(hidden).toMatch(/display:\s*none;/);
    // opacity and visibility hide the box but keep it in layout
    expect(hidden).not.toMatch(/opacity:\s*0/);
    expect(hidden).not.toMatch(/visibility:\s*hidden/);
  });

  it("are rendered on hover and on keyboard focus", () => {
    const shown = ruleBody(
      "[data-tooltip]:hover::after,\n[data-tooltip]:focus-visible::after",
    );
    expect(shown).toMatch(/display:\s*block;/);
  });

  it("wrap inside the viewport instead of running off one line", () => {
    const hidden = ruleBody("[data-tooltip]::after");
    expect(hidden).toMatch(/max-width:\s*min\(280px, calc\(100vw - 2rem\)\);/);
    expect(hidden).not.toMatch(/white-space:\s*nowrap/);
  });
});
