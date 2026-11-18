/**
 * brand/admin-brand-tokens.unit.test.ts
 * Guards drift between the shared-base colors in brand/tokens.json (metrics
 * dashboard palette) and @app-vitals/agent-admin's brand-tokens.json (admin UI
 * palette). Both derive from agent/lib/web/toolbar.ts but use different key
 * names, so the shared base is declared as an explicit mapping.
 */

import { describe, expect, it } from "bun:test";
import adminTokens from "@app-vitals/agent-admin/brand-tokens.json";
import dashboardTokens from "./tokens.json";

type Tree = { [key: string]: string | Tree };

function lookup(tree: Tree, path: string): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const key of path.split(".")) {
    if (typeof node !== "object") return undefined;
    node = node[key];
  }
  return typeof node === "string" ? node : undefined;
}

// dashboard `color.<key>` -> admin `color.<path>`
const SHARED_BASE: Record<string, string> = {
  bg: "bg.page",
  surface: "bg.surface",
  surfaceRaised: "bg.subtle",
  border: "border.default",
  borderAccent: "border.strong",
  text: "text.heading",
  textDim: "text.muted",
  textMuted: "text.faint",
  accent: "brand.default",
  accentDim: "brand.strong",
};

describe("admin vs dashboard brand tokens", () => {
  for (const [dashboardKey, adminPath] of Object.entries(SHARED_BASE)) {
    it(`color.${dashboardKey} matches admin color.${adminPath}`, () => {
      const dashboardValue = (dashboardTokens.color as Record<string, string>)[
        dashboardKey
      ];
      const adminValue = lookup(adminTokens.color as Tree, adminPath);
      expect(dashboardValue).toBeDefined();
      expect(adminValue).toBeDefined();
      expect(adminValue).toBe(dashboardValue);
    });
  }
});
