import { expect, test } from "bun:test";
import { parseCobertura } from "./cobertura.ts";

test("parseCobertura reads root lines-covered/lines-valid, ignoring rates", () => {
  const xml = `<?xml version="1.0"?>
<coverage line-rate="0.99" branch-rate="0" lines-covered="8" lines-valid="10" branches-covered="1" branches-valid="2" version="1">
  <packages/>
</coverage>`;
  const r = parseCobertura(xml);
  expect(r?.tool).toBe("cobertura");
  expect(r?.lines).toEqual({ covered: 8, total: 10 });
  expect(r?.branches).toEqual({ covered: 1, total: 2 });
});

test("parseCobertura falls back to counting <line hits> without method duplicates", () => {
  const xml = `<coverage line-rate="1.0">
<packages><package><classes><class name="A">
<methods><method name="m"><lines><line number="1" hits="1"/></lines></method></methods>
<lines><line number="1" hits="1"/><line number="2" hits="0"/><line number="3" hits="4"/></lines>
</class></classes></package></packages></coverage>`;
  const r = parseCobertura(xml);
  expect(r?.lines).toEqual({ covered: 2, total: 3 });
  expect(r && "branches" in r).toBe(false);
});

test("parseCobertura returns null when there is no coverage root", () => {
  expect(parseCobertura("<report/>")).toBeNull();
});
