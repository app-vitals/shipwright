/**
 * metrics/src/dashboard/navbar-drift.unit.test.ts
 * Contract test: any nav item added to the shared toolbar must be consciously
 * handled by the metrics dashboard. The expected set is derived from the
 * library's TOOLBAR_NAV_ITEMS manifest (the authoritative source), never
 * hardcoded here.
 */

import { describe, expect, test } from "bun:test";
import { TOOLBAR_NAV_ITEMS } from "@app-vitals/agent-lib/web/toolbar.ts";
import { renderDashboardPage } from "./dashboard-page.ts";

/**
 * Toolbar nav items that metrics deliberately does not render for owners/admins.
 * Keyed by nav label; each entry must carry a non-empty reason and must still be
 * absent from the metrics render (a stale exemption fails the test).
 */
const INTENTIONALLY_HIDDEN: Record<string, string> = {};

/** Visible labels of every `.vos-nav-link` anchor in a rendered HTML string. */
function navLabels(html: string): string[] {
  return [
    ...html.matchAll(/<a href="[^"]*" class="vos-nav-link[^"]*">([^<]*)<\/a>/g),
  ].map((m) => (m[1] as string).replace(/&amp;/g, "&"));
}

// Full admin nav set: labels of every manifest item the admin audience sees.
const fullSet = TOOLBAR_NAV_ITEMS.filter((i) =>
  i.audiences.includes("admin"),
).map((i) => i.label);

const metricsAdminSet = navLabels(
  renderDashboardPage({ userName: "Alice", isOwner: true, audience: "admin" }),
);

describe("metrics navbar — shared toolbar drift guard", () => {
  test("library render yields a non-trivial nav set", () => {
    expect(fullSet.length).toBeGreaterThan(1);
  });

  test("metrics owner/admin render contains every toolbar link except intentional exemptions", () => {
    const missing = fullSet.filter(
      (label) =>
        !metricsAdminSet.includes(label) && !(label in INTENTIONALLY_HIDDEN),
    );
    expect(missing).toEqual([]);
  });

  test("INTENTIONALLY_HIDDEN entries each carry a non-empty reason", () => {
    for (const [label, reason] of Object.entries(INTENTIONALLY_HIDDEN)) {
      expect(reason.trim().length, `reason for ${label}`).toBeGreaterThan(0);
    }
  });

  test("INTENTIONALLY_HIDDEN has no unused or stale entries", () => {
    for (const label of Object.keys(INTENTIONALLY_HIDDEN)) {
      // Unused: the toolbar no longer offers this link at all.
      expect(fullSet, `${label} not in toolbar`).toContain(label);
      // Stale: metrics now renders it, so the exemption is no longer needed.
      expect(metricsAdminSet, `${label} now rendered`).not.toContain(label);
    }
  });

  test("public readOnly render contains no auth-gated links", () => {
    const html = renderDashboardPage({
      userName: "Alice",
      readOnly: true,
      audience: "public",
    });
    const publicLabels = TOOLBAR_NAV_ITEMS.filter((i) =>
      i.audiences.includes("public"),
    ).map((i) => i.label);
    expect(navLabels(html).sort()).toEqual(publicLabels.sort());
    expect(html).not.toContain('action="/admin/logout"');
  });
});
