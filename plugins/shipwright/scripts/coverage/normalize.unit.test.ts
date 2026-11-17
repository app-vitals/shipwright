import { expect, test } from "bun:test";
import { normalizeReports, parseShipwrightJson } from "./normalize.ts";

const LCOV_A = "SF:a\nLF:10\nLH:5\nend_of_record\n";
const LCOV_B = "SF:b\nLF:4\nLH:4\nend_of_record\n";

test("sums two lcov files", () => {
  const r = normalizeReports([
    { name: "a/lcov.info", content: LCOV_A },
    { name: "b/lcov.info", content: LCOV_B },
  ]);
  expect(r?.lines).toEqual({ covered: 9, total: 14 });
  expect(r?.tool).toBe("lcov");
});

test("ignores unrecognised files and returns null when none match", () => {
  const r = normalizeReports([
    { name: "notes.txt", content: "hello" },
    { name: "lcov.info", content: LCOV_A },
  ]);
  expect(r?.lines).toEqual({ covered: 5, total: 10 });
  expect(normalizeReports([{ name: "x", content: "nope" }])).toBeNull();
  expect(normalizeReports([])).toBeNull();
});

test("sums mixed formats and only sums optional metrics where present", () => {
  const lcov = "SF:a\nLF:2\nLH:1\nBRF:2\nBRH:1\nend_of_record\n";
  const go = "mode: set\na.go:1.1,2.2 3 1\n";
  const r = normalizeReports([
    { name: "l", content: lcov },
    { name: "g", content: go },
  ]);
  expect(r?.lines).toEqual({ covered: 4, total: 5 });
  expect(r?.branches).toEqual({ covered: 1, total: 2 });
  expect(r && "functions" in r).toBe(false);
  expect(r?.tool).toBe("go-cover+lcov");
});

test("go-only result has no branches or functions", () => {
  const r = normalizeReports([
    { name: "c.out", content: "mode: set\na.go:1.1,2.2 3 1\n" },
  ]);
  expect(r && "branches" in r).toBe(false);
  expect(r && "functions" in r).toBe(false);
});

test("shipwright-coverage.json is accepted as-is", () => {
  const json = JSON.stringify({
    lines: { covered: 3, total: 4 },
    branches: { covered: 1, total: 2 },
    tool: "custom",
  });
  const r = normalizeReports([
    { name: "shipwright-coverage.json", content: json },
  ]);
  expect(r).toEqual({
    lines: { covered: 3, total: 4 },
    branches: { covered: 1, total: 2 },
    tool: "custom",
  });
});

test("parseShipwrightJson rejects covered > total, missing lines and bad JSON", () => {
  expect(
    parseShipwrightJson(JSON.stringify({ lines: { covered: 5, total: 4 } })),
  ).toBeNull();
  expect(parseShipwrightJson(JSON.stringify({ tool: "x" }))).toBeNull();
  expect(parseShipwrightJson("{not json")).toBeNull();
  expect(
    parseShipwrightJson(JSON.stringify({ lines: { covered: -1, total: 4 } })),
  ).toBeNull();
  expect(
    parseShipwrightJson(
      JSON.stringify({
        lines: { covered: 1, total: 4 },
        branches: { covered: 9, total: 4 },
      }),
    ),
  ).toBeNull();
});

test("a rejected shipwright-coverage.json is ignored as unparseable", () => {
  const bad = JSON.stringify({ lines: { covered: 5, total: 4 } });
  expect(
    normalizeReports([{ name: "shipwright-coverage.json", content: bad }]),
  ).toBeNull();
});
