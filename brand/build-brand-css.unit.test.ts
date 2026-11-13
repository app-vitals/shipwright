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
  for (const cls of [
    ".sw-btn",
    ".sw-card",
    ".sw-callout",
    ".sw-pill",
    ".sw-container",
  ]) {
    expect(css).toContain(cls);
  }
});

test("generated CSS does NOT contain the retired electric blue", () => {
  expect(css.toUpperCase()).not.toContain("#3B82F6");
});

// Install command: the old single-step form fails (the plugin is not in a registered marketplace);
// the working form is `marketplace add` then `install shipwright@shipwright`.
const WORKING_ADD = "/plugin marketplace add app-vitals/shipwright";
const WORKING_INSTALL = "/plugin install shipwright@shipwright";
const FAILING_INSTALL = "/plugin install shipwright@app-vitals/shipwright";

test("brand tokens, docs, templates and demo slide use the working two-step install", async () => {
  expect(tokens.brand.install).toEqual([WORKING_ADD, WORKING_INSTALL]);
  for (const rel of [
    "BRAND.md",
    "templates/deck.html",
    "templates/one-pager.html",
    "../demo/slides/close.html",
  ]) {
    const text = await Bun.file(new URL(rel, import.meta.url)).text();
    expect(text).toContain(WORKING_ADD);
    expect(text).toContain(WORKING_INSTALL);
    expect(text).not.toContain(FAILING_INSTALL);
  }
  expect(JSON.stringify(tokens)).not.toContain(FAILING_INSTALL);
});
