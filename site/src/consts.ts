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

export interface NavLink {
  href: string;
  label: string;
}

/**
 * Canonical primary nav link set (desktop header nav + mobile nav panels).
 *
 * Single source of truth — was hand-rolled separately in BaseLayout and
 * DocsLayout, which let DocsLayout's copies drift and silently drop the
 * "vs Devin" and "Agent Model" links. Centralized here so every nav surface
 * renders the same list. D10-designated link (brand/MESSAGING.md D10) — one
 * "vs Devin" entry only, no additional claim text.
 */
export const PRIMARY_NAV_LINKS: NavLink[] = [
  { href: "/docs/introduction", label: "Docs" },
  { href: "/compare", label: "Compare" },
  { href: "/vs/devin", label: "vs Devin" },
  { href: "/agent-model", label: "Agent Model" },
  { href: "/story", label: "Story" },
];

/**
 * Hardcoded architecture page links for the DocsLayout sidebar.
 *
 * /agent-model and /service-architecture are standalone BaseLayout pages
 * outside the docs content collection. These links render in the sidebar's
 * Reference section, allowing readers to navigate from docs content to the
 * architecture pages. Single source of truth ensures the sidebar links stay
 * in sync with the actual routes.
 */
export const DOCS_SIDEBAR_SUPPLEMENTAL_LINKS: NavLink[] = [
  { href: "/agent-model", label: "Agent Model" },
  { href: "/service-architecture", label: "Service Architecture" },
];
