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

/** Body of the first rule for `selector`, wherever it sits in the file. */
function blockBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`rule not found: ${selector}`);
  return match[1];
}

describe("dashboard themes", () => {
  it("keys the dark palette off data-theme on the root element", () => {
    const dark = blockBody(':root[data-theme="dark"]');
    expect(dark).toMatch(/color-scheme:\s*dark;/);
    expect(dark).toMatch(/--bg:\s*#[0-9a-f]{6};/);
  });

  it("has no hard-coded colours outside the two palette blocks", () => {
    const withoutPalettes = css
      .replace(/:root\s*\{[^}]*\}/, "")
      .replace(/:root\[data-theme="dark"\]\s*\{[^}]*\}/, "");
    const hex: string[] = withoutPalettes.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    // Neutral black shadows and the modal backdrop read the same in both themes.
    const rgb: string[] = (
      withoutPalettes.match(/rgba?\([^)]*\)/g) ?? []
    ).filter((c) => !c.startsWith("rgba(0, 0, 0, "));
    expect([...hex, ...rgb]).toEqual([]);
  });

  it("restyles the shared toolbar in dark", () => {
    expect(blockBody('[data-theme="dark"] .vos-toolbar')).toMatch(
      /background:\s*var\(--surface\);/,
    );
  });
});
