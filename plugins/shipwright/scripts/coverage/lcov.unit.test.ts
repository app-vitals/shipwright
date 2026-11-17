import { expect, test } from "bun:test";
import { parseLcov } from "./lcov.ts";

const LCOV = `TN:
SF:src/a.ts
FNF:2
FNH:1
BRF:4
BRH:3
LF:10
LH:8
end_of_record
SF:src/b.ts
FNF:1
FNH:1
LF:5
LH:5
end_of_record
`;

test("parseLcov sums LF/LH across SF records", () => {
  const r = parseLcov(LCOV);
  expect(r?.tool).toBe("lcov");
  expect(r?.lines).toEqual({ covered: 13, total: 15 });
  expect(r?.functions).toEqual({ covered: 2, total: 3 });
  expect(r?.branches).toEqual({ covered: 3, total: 4 });
});

test("parseLcov omits branches/functions when no records report them", () => {
  const r = parseLcov("SF:a\nLF:2\nLH:1\nend_of_record\n");
  expect(r?.lines).toEqual({ covered: 1, total: 2 });
  expect(r && "branches" in r).toBe(false);
  expect(r && "functions" in r).toBe(false);
});

test("parseLcov handles CRLF and returns null without SF records", () => {
  expect(parseLcov("SF:a\r\nLF:2\r\nLH:2\r\n")?.lines.total).toBe(2);
  expect(parseLcov("nothing here")).toBeNull();
});
