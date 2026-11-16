/**
 * admin/src/coding/coding-settings-nav.unit.test.ts
 * The coding extension's settings-sidebar contributions (SGL-3.2).
 */

import { describe, expect, it } from "bun:test";
import {
  type AdminExtensionContext,
  resolveAdminExtensions,
} from "@app-vitals/agent-admin/admin-extension";
import { codingAdminExtension } from "./coding-admin-extension.ts";
import {
  CODING_SETTINGS_NAV_ITEMS,
  codingSettingsNav,
} from "./coding-settings-nav.ts";

const ctx = {
  env: {},
  prisma: {},
  services: {},
} as unknown as AdminExtensionContext;

describe("codingAdminExtension.settingsNavItems", () => {
  it("contributes System crons (Platform, adminOnly) and Notifications (Personal)", () => {
    expect(CODING_SETTINGS_NAV_ITEMS).toEqual([
      {
        section: "Platform",
        label: "System crons",
        path: "/admin/settings/system-crons",
        adminOnly: true,
      },
      {
        section: "Personal",
        label: "Notifications",
        path: "/admin/settings/notifications",
      },
    ]);
  });

  it("is resolved through the extension hook", () => {
    const resolved = resolveAdminExtensions([codingAdminExtension], ctx);
    expect(resolved.settingsNavItems).toEqual([...CODING_SETTINGS_NAV_ITEMS]);
  });

  it("merges into the sidebar: System crons under Platform, Notifications under Personal", () => {
    const nav = codingSettingsNav();
    const platform = nav.sections.find((s) => s.label === "Platform");
    const personal = nav.sections.find((s) => s.label === "Personal");
    expect(platform?.items.map((i) => i.path)).toContain(
      "/admin/settings/system-crons",
    );
    expect(personal?.items.map((i) => i.path)).toEqual([
      "/admin/settings/notifications",
    ]);
  });

  it("includes Templates in the Platform section", () => {
    const platform = codingSettingsNav().sections.find(
      (s) => s.label === "Platform",
    );
    expect(platform?.items.map((i) => i.path)).toContain(
      "/admin/settings/templates",
    );
  });
});
