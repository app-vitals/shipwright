/**
 * admin/src/main.ts
 *
 * Standalone admin service entrypoint (Dockerfile ENTRYPOINT) and Shipwright's
 * admin composition root: the only file that imports both the admin platform
 * boot (admin-boot.ts) and the coding extension. The boot sequence itself —
 * migrations, services, routes, sweepers, serve — lives in startAdmin().
 *
 * Import-safe: startAdmin() only runs when this file is the main entry, so
 * tests and scripts/generate-admin-spec.ts can import from it.
 */

import { startAdmin } from "./admin-boot.ts";
import type { AdminExtension } from "./admin-extension.ts";
import { codingAdminExtension } from "./coding/coding-admin-extension.ts";

// Re-exported so existing importers of main.ts keep working unchanged.
export {
  buildProvisioner,
  checkDbReady,
  DEFAULT_SESSION_ALERT_INTERVAL_MS,
  isAnthropicFederationEnabled,
  type ParsedAnthropicFederation,
  type PerAgentAnthropicFederation,
  parseAnthropicFederation,
  resolvePublicRepo,
  resolveSessionAlertIntervalMs,
  resolveTrialExpiryWarningDays,
  runMigrations,
} from "./admin-boot-config.ts";

/** The extensions Shipwright's admin is composed of. */
export const adminExtensions: readonly AdminExtension[] = [
  codingAdminExtension,
];

// Run directly when invoked as main entry
if (import.meta.main) {
  startAdmin(adminExtensions).catch((err) => {
    console.error("[admin] fatal startup error:", err);
    process.exit(1);
  });
}
