/**
 * Canonical booking destination for the discovery call.
 *
 * Single source of truth — imported by pages, layouts, and the Playwright specs
 * so a URL swap is one line here and the tests cannot drift from the source.
 */
export const BOOKING_URL = "https://vitals-os.com/cal/book/discovery";

/**
 * Canonical GitHub repo URL.
 *
 * Single source of truth — was redeclared as a local const across multiple
 * pages and layouts; centralized here so a repo move is one line, not five.
 */
export const REPO_URL = "https://github.com/app-vitals/shipwright";

/**
 * Canonical plugin install command shown in CTAs across the site.
 *
 * Single source of truth — was redeclared as a local const across multiple
 * pages; centralized here so the command cannot drift between pages.
 */
export const INSTALL_CMD = "/plugin install shipwright@app-vitals/shipwright";

/**
 * Canonical URL to the repo's LICENSE file.
 *
 * Single source of truth — was redeclared as a local const across multiple
 * pages and layouts; centralized here so a license-location change is one line.
 */
export const LICENSE_URL =
  "https://github.com/app-vitals/shipwright/blob/main/LICENSE";
