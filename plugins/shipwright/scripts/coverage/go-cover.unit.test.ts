import { expect, test } from "bun:test";
import { parseGoCover } from "./go-cover.ts";

const PROFILE = `mode: set
example.com/p/a.go:1.1,3.2 2 1
example.com/p/a.go:5.1,6.2 3 0
example.com/p/b.go:1.1,2.2 5 7
`;

test("parseGoCover counts statements as lines", () => {
  const r = parseGoCover(PROFILE);
  expect(r?.tool).toBe("go-cover");
  expect(r?.lines).toEqual({ covered: 7, total: 10 });
});

test("parseGoCover result has no branches or functions keys", () => {
  const r = parseGoCover(PROFILE);
  expect(r && "branches" in r).toBe(false);
  expect(r && "functions" in r).toBe(false);
});

test("parseGoCover accepts count/atomic modes and rejects other input", () => {
  expect(parseGoCover("mode: atomic\na.go:1.1,2.2 4 9\n")?.lines).toEqual({
    covered: 4,
    total: 4,
  });
  expect(parseGoCover("mode: count\n")?.lines).toEqual({
    covered: 0,
    total: 0,
  });
  expect(parseGoCover("SF:a\n")).toBeNull();
});
