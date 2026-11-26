/**
 * brand/dashboard-tokens.unit.test.ts
 * Guards brand/tokens.json (the metrics dashboard's real palette): color +
 * colorDark + font schema, every :root custom property in styles.css is
 * represented, and the dark theme block matches colorDark key for key.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import tokens from "./tokens.json";

const HEX = /^#[0-9a-f]{6}$/i;

const toKebab = (s: string) =>
  s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

describe("dashboard brand tokens", () => {
  it("matches the color + colorDark + font schema", () => {
    const keys = Object.keys(tokens).filter((k) => !k.startsWith("$"));
    expect(keys.sort()).toEqual(["color", "colorDark", "font"]);
    for (const value of Object.values(tokens.color)) {
      expect(value).toMatch(HEX);
    }
    for (const value of Object.values(tokens.colorDark)) {
      expect(value).toMatch(HEX);
    }
    for (const value of Object.values(tokens.font)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("covers every :root custom property in styles.css with identical values", () => {
    const css = readFileSync(
      new URL("../metrics/src/dashboard/styles.css", import.meta.url),
      "utf8",
    );
    const root = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
    const props = [...root.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)];
    expect(props.length).toBeGreaterThan(0);

    const flat = new Map<string, string>();
    for (const [k, v] of Object.entries({ ...tokens.color, ...tokens.font })) {
      flat.set(toKebab(k), v);
    }
    for (const [, name, value] of props) {
      expect(flat.get(name)).toBe(value.trim());
    }
  });

  it("defines a dark value for every light colour, and no extras", () => {
    expect(Object.keys(tokens.colorDark).sort()).toEqual(
      Object.keys(tokens.color).sort(),
    );
  });

  it("matches the dark theme block in styles.css exactly", () => {
    const css = readFileSync(
      new URL("../metrics/src/dashboard/styles.css", import.meta.url),
      "utf8",
    );
    const dark =
      css.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1] ?? "";
    const props = new Map(
      [...dark.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map(
        ([, name, value]) => [name, value.trim()] as [string, string],
      ),
    );
    const expected = new Map(
      Object.entries(tokens.colorDark).map(
        ([k, v]) => [toKebab(k), v] as [string, string],
      ),
    );
    expect([...props.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [name, value] of expected) {
      expect(props.get(name)).toBe(value);
    }
  });
});
