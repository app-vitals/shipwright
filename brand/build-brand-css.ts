#!/usr/bin/env bun
/**
 * Generates `brand/brand.css` from `brand/tokens.json`.
 *
 * tokens.json is the single source of truth; this derives the stylesheet
 * (CSS custom properties + a small set of on-brand utility classes) so every
 * Shipwright Harness artifact inherits the tokens by construction rather than
 * by hand-copied hexes. Re-run after editing tokens.json.
 *
 *   bun brand/build-brand-css.ts        # writes brand/brand.css
 */

import tokens from "./tokens.json";

type ColorGroup = Record<string, string>;
interface TypeToken {
  size: string;
  line: string;
  weight: number;
  tracking: string;
  font: string;
  transform?: string;
}
interface BrandTokens {
  color: Record<string, ColorGroup | string>;
  gradient: Record<string, string[]>;
  glow: Record<string, string>;
  font: Record<string, string>;
  type: Record<string, TypeToken>;
  radius: Record<string, string>;
  layout: Record<string, string>;
}

const kebab = (s: string): string =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/** Pure: parsed tokens → CSS string. Exported for tests. */
export function tokensToCss(t: BrandTokens): string {
  const vars: string[] = [];

  for (const [group, entries] of Object.entries(t.color)) {
    if (typeof entries !== "object") continue; // skip $-prefixed notes
    for (const [key, value] of Object.entries(entries)) {
      vars.push(`  --sw-color-${group}-${kebab(key)}: ${value};`);
    }
  }
  for (const [key, stops] of Object.entries(t.gradient)) {
    vars.push(
      `  --sw-gradient-${kebab(key)}: linear-gradient(135deg, ${stops.join(", ")});`,
    );
  }
  for (const [key, value] of Object.entries(t.glow)) {
    vars.push(`  --sw-glow-${kebab(key)}: ${value};`);
  }
  for (const [key, value] of Object.entries(t.font)) {
    vars.push(`  --sw-font-${kebab(key)}: ${value};`);
  }
  for (const [key, value] of Object.entries(t.radius)) {
    vars.push(`  --sw-radius-${kebab(key)}: ${value};`);
  }
  for (const [key, value] of Object.entries(t.layout)) {
    vars.push(`  --sw-layout-${kebab(key)}: ${value};`);
  }
  for (const [name, tok] of Object.entries(t.type)) {
    const base = `--sw-text-${kebab(name)}`;
    vars.push(`  ${base}-size: ${tok.size};`);
    vars.push(`  ${base}-line: ${tok.line};`);
    vars.push(`  ${base}-weight: ${tok.weight};`);
    vars.push(`  ${base}-tracking: ${tok.tracking};`);
  }

  return `/* GENERATED from brand/tokens.json by build-brand-css.ts — do not edit by hand. */
:root {
  color-scheme: dark;
${vars.join("\n")}
}

body {
  margin: 0;
  background: var(--sw-color-bg-base);
  color: var(--sw-color-text-body);
  font-family: var(--sw-font-body);
  font-size: var(--sw-text-body-size);
  line-height: var(--sw-text-body-line);
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3 { font-family: var(--sw-font-display); color: var(--sw-color-text-heading); margin: 0 0 0.5em; }
h1 { font-size: var(--sw-text-h1-size); line-height: var(--sw-text-h1-line); font-weight: var(--sw-text-h1-weight); letter-spacing: var(--sw-text-h1-tracking); }
h2 { font-size: var(--sw-text-h2-size); line-height: var(--sw-text-h2-line); font-weight: var(--sw-text-h2-weight); letter-spacing: var(--sw-text-h2-tracking); }
h3 { font-size: var(--sw-text-h3-size); line-height: var(--sw-text-h3-line); font-weight: var(--sw-text-h3-weight); }
a { color: var(--sw-color-support-patriot-bright); text-decoration: none; }
a:hover { color: var(--sw-color-support-cyan); }
code, .sw-mono { font-family: var(--sw-font-mono); }

.sw-container { max-width: var(--sw-layout-max-width); margin: 0 auto; padding: 0 var(--sw-layout-gutter); }
.sw-display { font-family: var(--sw-font-display); font-size: var(--sw-text-display-xl-size); line-height: var(--sw-text-display-xl-line); font-weight: var(--sw-text-display-xl-weight); letter-spacing: var(--sw-text-display-xl-tracking); color: var(--sw-color-text-heading); }
.sw-label { font-family: var(--sw-font-mono); text-transform: uppercase; letter-spacing: var(--sw-text-label-tracking); font-size: var(--sw-text-label-size); font-weight: var(--sw-text-label-weight); color: var(--sw-color-text-muted); }
.sw-stat { font-family: var(--sw-font-display); font-size: var(--sw-text-display-l-size); line-height: var(--sw-text-display-l-line); font-weight: var(--sw-text-display-l-weight); color: var(--sw-color-text-heading); }
.sw-muted { color: var(--sw-color-text-muted); }
.sw-editorial { color: var(--sw-color-text-editorial); }

.sw-btn { display: inline-block; padding: 0.75rem 1.25rem; border-radius: var(--sw-radius-md); background: var(--sw-color-brand-default); color: var(--sw-color-brand-on-brand-text); font-family: var(--sw-font-body); font-weight: 600; border: 0; cursor: pointer; }
.sw-btn:hover { background: var(--sw-color-brand-strong); }
.sw-btn-secondary { background: transparent; color: var(--sw-color-text-heading); border: 1px solid var(--sw-color-border-strong); }

.sw-card { background: var(--sw-color-bg-raised); border: 1px solid var(--sw-color-border-muted); border-radius: var(--sw-radius-lg); padding: 1.5rem; }
.sw-callout { border-left: 3px solid var(--sw-color-brand-default); background: var(--sw-color-brand-soft); border-radius: var(--sw-radius-md); padding: 1rem 1.25rem; }
.sw-callout-info { border-left-color: var(--sw-color-support-patriot-bright); background: color-mix(in srgb, var(--sw-color-support-patriot) 45%, transparent); }
.sw-callout-warn { border-left-color: var(--sw-color-state-warning); background: color-mix(in srgb, var(--sw-color-state-warning) 12%, transparent); }

.sw-pill { display: inline-block; padding: 0.2rem 0.6rem; border-radius: var(--sw-radius-pill); font-family: var(--sw-font-mono); font-size: var(--sw-text-label-size); text-transform: uppercase; letter-spacing: 0.06em; }
.sw-pill-success { background: var(--sw-color-brand-soft); color: var(--sw-color-brand-default); }
.sw-pill-progress { background: var(--sw-color-support-patriot); color: var(--sw-color-support-patriot-bright); }

.sw-h1 { font-family: var(--sw-font-display); font-size: var(--sw-text-h1-size); line-height: var(--sw-text-h1-line); font-weight: var(--sw-text-h1-weight); letter-spacing: var(--sw-text-h1-tracking); color: var(--sw-color-text-heading); }
.sw-code { background: var(--sw-color-bg-overlay); border-radius: var(--sw-radius-md); padding: 0.85rem 1rem; font-family: var(--sw-font-mono); color: var(--sw-color-text-body); overflow: auto; }
.sw-gradient-text { background: var(--sw-gradient-brand); -webkit-background-clip: text; background-clip: text; color: transparent; }
.sw-orb { position: absolute; border-radius: 50%; filter: blur(80px); pointer-events: none; z-index: 0; }
.sw-orb-brand { background: var(--sw-glow-brand); }
.sw-orb-support { background: var(--sw-glow-support); }
`;
}

if (import.meta.main) {
  const css = tokensToCss(tokens as unknown as BrandTokens);
  const outPath = new URL("./brand.css", import.meta.url).pathname;
  await Bun.write(outPath, css);
  console.log(`✓ wrote ${outPath} (${css.length} bytes)`);
}
