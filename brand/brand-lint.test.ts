import { expect, test } from "bun:test";
import { allowedHexes, lintBrand } from "./brand-lint";

test("allowed palette includes brand + support hexes and white", () => {
  const allowed = allowedHexes();
  expect(allowed.has("#34C77B")).toBe(true); // ship green
  expect(allowed.has("#002244")).toBe(true); // patriot
  expect(allowed.has("#4F8EF7")).toBe(true); // patriot bright
  expect(allowed.has("#FFFFFF")).toBe(true);
});

test("an artifact using only token hexes passes clean", () => {
  const onBrand =
    "a { color: #34C77B; } body { background: #080E1E; } .x { color: #FFFFFF; }";
  expect(lintBrand(onBrand).offBrandHexes).toEqual([]);
});

test("artifacts using CSS variables (no raw hexes) pass clean", () => {
  const viaVars =
    ".sw-btn { background: var(--sw-color-brand-default); color: var(--sw-color-brand-on-brand-text); }";
  expect(lintBrand(viaVars).offBrandHexes).toEqual([]);
});

test("the retired electric blue is flagged as off-brand", () => {
  const { offBrandHexes } = lintBrand("a { color: #3B82F6; }");
  expect(offBrandHexes).toContain("#3B82F6");
});

test("arbitrary off-palette colors are flagged", () => {
  const { offBrandHexes } = lintBrand(
    "h1 { color: #FF0000; } p { color: #123ABC; }",
  );
  expect(offBrandHexes).toContain("#FF0000");
  expect(offBrandHexes).toContain("#123ABC");
});
