import { describe, expect, it } from "bun:test";
import { normalizePr } from "./validate.ts";

describe("normalizePr", () => {
  it("passes undefined and null through", () => {
    expect(normalizePr(undefined)).toEqual({ ok: true, value: undefined });
    expect(normalizePr(null)).toEqual({ ok: true, value: null });
  });
  it("accepts integers and integer strings", () => {
    expect(normalizePr(12)).toEqual({ ok: true, value: 12 });
    expect(normalizePr("12")).toEqual({ ok: true, value: 12 });
  });
  it("extracts the number from a github pull URL", () => {
    expect(
      normalizePr("https://github.com/app-vitals/shipwright/pull/6296"),
    ).toEqual({ ok: true, value: 6296 });
  });
  it.each([
    "abc",
    "",
    "1.5",
    0,
    -1,
    1.5,
    Number.NaN,
    "https://github.com/a/b/pull/x",
    {},
    [[]],
  ])("rejects %p", (v) => {
    const r = normalizePr(
      Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) ? [] : v,
    );
    expect(r.ok).toBe(false);
  });
});
