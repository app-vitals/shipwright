import { expect, test } from "bun:test";
import { tokensToCss } from "./build-brand-css";
import tokens from "./tokens.json";

// biome-ignore lint/suspicious/noExplicitAny: tokens.json is structurally compatible with the BrandTokens shape the generator expects.
const css = tokensToCss(tokens as any);

test("generated CSS carries the signature Shipwright Harness hexes", () => {
  expect(css).toContain("#34C77B"); // ship green (hero)
  expect(css).toContain("#002244"); // patriot blue (support surface)
  expect(css).toContain("#4F8EF7"); // patriot bright (links/state)
});

test("generated CSS exposes the required brand custom properties", () => {
  for (const v of [
    "--sw-color-bg-base",
    "--sw-color-brand-default",
    "--sw-color-brand-on-brand-text",
    "--sw-color-support-patriot",
    "--sw-color-support-patriot-bright",
    "--sw-font-display",
    "--sw-text-h1-size",
    "--sw-gradient-brand",
    "--sw-radius-md",
  ]) {
    expect(css).toContain(v);
  }
});

test("generated CSS ships the on-brand utility classes", () => {
  for (const cls of [".sw-btn", ".sw-card", ".sw-callout", ".sw-pill", ".sw-container"]) {
    expect(css).toContain(cls);
  }
});

test("generated CSS does NOT contain the retired electric blue", () => {
  expect(css.toUpperCase()).not.toContain("#3B82F6");
});
