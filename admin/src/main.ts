/**
 * admin/src/main.ts
 *
 * Standalone admin service entrypoint (Dockerfile ENTRYPOINT) and Shipwright's
 * admin composition root: the only file that imports both the platform admin
 * boot (@app-vitals/agent-admin/admin-boot) and the coding extension. The boot
 * sequence itself — migrations, services, routes, sweepers, serve — lives in
 * the platform package's startAdmin().
 *
 * Import-safe: startAdmin() only runs when this file is the main entry, so
 * tests and scripts/generate-admin-spec.ts can import from it.
 */

import { join } from "node:path";
import { startAdmin } from "@app-vitals/agent-admin/admin-boot";
import type { AdminExtension } from "@app-vitals/agent-admin/admin-extension";
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
} from "@app-vitals/agent-admin/admin-boot-config";

/** The extensions Shipwright's admin is composed of. */
export const adminExtensions: readonly AdminExtension[] = [
  codingAdminExtension,
];

/**
 * Shipwright's specialties (coding, specialist) at the repo root. The platform
 * resolves its default specialties dir relative to its own install location,
 * which is inside node_modules now that it comes from @app-vitals/agent-admin,
 * so the composition root supplies Shipwright's.
 */
export const SHIPWRIGHT_SPECIALTIES_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "specialties",
);

/**
 * Defaults SHIPWRIGHT_SPECIALTIES_DIR to Shipwright's specialties; an
 * operator-set value wins. Applied once at startup, before startAdmin().
 */
export function applyShipwrightDefaults(
  env: Record<string, string | undefined>,
): void {
  env.SHIPWRIGHT_SPECIALTIES_DIR ||= SHIPWRIGHT_SPECIALTIES_DIR;
}

// Run directly when invoked as main entry
if (import.meta.main) {
  applyShipwrightDefaults(process.env);
  startAdmin(adminExtensions).catch((err) => {
    console.error("[admin] fatal startup error:", err);
    process.exit(1);
  });
}
