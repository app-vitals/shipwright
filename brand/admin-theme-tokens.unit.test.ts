/**
 * brand/admin-theme-tokens.unit.test.ts
 * Guards drift between admin's own theme token subset and brand/tokens.json.
 */

import { describe, expect, it } from "bun:test";
import adminTokens from "@shipwright/admin/theme-tokens.json";
import brandTokens from "./tokens.json";

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ""): [string, string][] {
  return Object.entries(tree)
    .filter(([key]) => !key.startsWith("$"))
    .flatMap(([key, value]) =>
      typeof value === "string"
        ? [[`${prefix}${key}`, value] as [string, string]]
        : leaves(value, `${prefix}${key}.`),
    );
}

describe("admin theme tokens", () => {
  it("is a non-empty subset of brand/tokens.json with identical values", () => {
    const adminLeaves = leaves({ color: adminTokens.color } as Tree);
    expect(adminLeaves.length).toBeGreaterThan(0);
    const brandLookup = new Map(leaves({ color: brandTokens.color } as Tree));
    for (const [path, value] of adminLeaves) {
      expect(brandLookup.get(path)).toBe(value);
    }
  });
});
