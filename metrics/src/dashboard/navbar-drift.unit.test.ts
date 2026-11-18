/**
 * metrics/src/dashboard/navbar-drift.unit.test.ts
 * Contract test: any nav item added to the shared toolbar must be consciously
 * handled by the metrics dashboard. The expected link set is derived from the
 * library render (every boolean option enabled), never hardcoded here.
 */

import { describe, expect, test } from "bun:test";
import { renderShipwrightToolbar } from "@app-vitals/agent-lib/web/toolbar.ts";
import { renderDashboardPage } from "./dashboard-page.ts";

/**
 * Toolbar nav links that metrics deliberately does not render for owners/admins.
 * Keyed by href; each entry must carry a non-empty reason and must still be
 * absent from the metrics render (a stale exemption fails the test).
 */
const INTENTIONALLY_HIDDEN: Record<string, string> = {};

/** hrefs of every `.vos-nav-link` anchor in a rendered HTML string. */
function navHrefs(html: string): string[] {
  return [...html.matchAll(/<a href="([^"]*)" class="vos-nav-link[^"]*"/g)].map(
    (m) => m[1] as string,
  );
}

// Full nav set: signed-in render with every opt-in boolean (showSettings) on.
// readOnly is excluded — it switches to the public variant, covered below.
const fullSet = navHrefs(
  renderShipwrightToolbar({
    userName: "Alice",
    activePath: "/dashboard",
    logoutAction: "/admin/logout",
    metricsUrl: "/dashboard",
    showSettings: true,
  }),
);

const metricsAdminSet = navHrefs(
  renderDashboardPage({ userName: "Alice", isOwner: true, showSettings: true }),
);

describe("metrics navbar — shared toolbar drift guard", () => {
  test("library render yields a non-trivial nav set", () => {
    expect(fullSet.length).toBeGreaterThan(1);
  });

  test("metrics owner/admin render contains every toolbar link except intentional exemptions", () => {
    const missing = fullSet.filter(
      (href) =>
        !metricsAdminSet.includes(href) && !(href in INTENTIONALLY_HIDDEN),
    );
    expect(missing).toEqual([]);
  });

  test("INTENTIONALLY_HIDDEN entries each carry a non-empty reason", () => {
    for (const [href, reason] of Object.entries(INTENTIONALLY_HIDDEN)) {
      expect(reason.trim().length, `reason for ${href}`).toBeGreaterThan(0);
    }
  });

  test("INTENTIONALLY_HIDDEN has no unused or stale entries", () => {
    for (const href of Object.keys(INTENTIONALLY_HIDDEN)) {
      // Unused: the toolbar no longer offers this link at all.
      expect(fullSet, `${href} not in toolbar`).toContain(href);
      // Stale: metrics now renders it, so the exemption is no longer needed.
      expect(metricsAdminSet, `${href} now rendered`).not.toContain(href);
    }
  });

  test("public readOnly render contains no auth-gated links", () => {
    const html = renderDashboardPage({
      userName: "Alice",
      readOnly: true,
      showSettings: true,
    });
    expect(navHrefs(html).filter((h) => h.startsWith("/admin"))).toEqual([]);
    expect(html).not.toContain('action="/admin/logout"');
  });
});
