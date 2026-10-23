/**
 * admin/src/main.ts
 *
 * Admin composition root of the plain platform: no extensions. Downstream
 * images that add admin behavior replace this file with one that passes their
 * AdminExtension list to startAdmin().
 *
 * Import-safe: startAdmin() only runs when this file is the main entry.
 */

import { startAdmin } from "./admin-boot.ts";
import type { AdminExtension } from "./admin-extension.ts";

export const adminExtensions: readonly AdminExtension[] = [];

if (import.meta.main) {
  startAdmin(adminExtensions).catch((err) => {
    console.error("[admin] fatal startup error:", err);
    process.exit(1);
  });
}
