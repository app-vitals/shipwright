/**
 * admin/src/coding/coding-settings-nav.ts
 * The coding extension's settings-sidebar contributions (SGL-3.2): System
 * crons under Platform (admin only) and Notifications under Personal. The
 * extension hands them to the platform (settingsNavItems), which merges them
 * into its own sidebar; the coding pages render the platform-resolved nav.
 */

import type { SettingsNavContribution } from "@app-vitals/agent-admin/admin-extension";

export const SYSTEM_CRONS_NAV_PATH = "/admin/settings/system-crons";
export const NOTIFICATIONS_NAV_PATH = "/admin/settings/notifications";

export const CODING_SETTINGS_NAV_ITEMS: readonly SettingsNavContribution[] = [
  {
    section: "Platform",
    label: "System crons",
    path: SYSTEM_CRONS_NAV_PATH,
    adminOnly: true,
  },
  {
    section: "Personal",
    label: "Notifications",
    path: NOTIFICATIONS_NAV_PATH,
  },
];
