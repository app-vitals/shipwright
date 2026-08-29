/**
 * admin/src/admin-ui-layout.ts
 * Shared admin page-head helper — a dumb string wrapper around the
 * `<!DOCTYPE html>` boilerplate that every render*Page function in
 * admin-ui-pages.ts needs: charset, a normalized viewport meta, an escaped
 * title, a <style> tag combining baseStyles() with page-specific extra
 * rules, and the <body> wrapper.
 *
 * Deliberately carries no toolbar logic — callers still invoke
 * renderAdminToolbar() themselves as part of their `body` string (and
 * renderLoginPage has no toolbar at all).
 *
 * Follows the same inline HTML template string pattern as
 * metrics/src/dashboard/dashboard-page.ts.
 */

import { baseStyles, escapeHtml } from "./admin-ui-styles.ts";

export interface RenderAdminPageOptions {
  /** Raw, unescaped page title — HTML-escaped internally before rendering. */
  title: string;
  /** Extra CSS rules appended inside <style> after baseStyles(). */
  extraStyles?: string;
  /** Extra markup appended inside <head>, after the <style> tag. */
  headExtra?: string;
  /** Optional class attribute for <body>. Omitted entirely when unset. */
  bodyClass?: string;
  /** Body markup — callers own toolbar calls, cards, forms, etc. */
  body: string;
  /** Markup appended after `body`, still inside <body> (e.g. a page-level <script>). */
  bodyEnd?: string;
}

/**
 * Renders the shared `<!DOCTYPE html>` document wrapper used by every admin
 * page. The viewport meta is normalized to
 * `width=device-width, initial-scale=1, viewport-fit=cover` —
 * `viewport-fit=cover` is load-bearing: it's what makes
 * `env(safe-area-inset-*)` return non-zero on iOS, which the sticky composer
 * and standalone/PWA mode both need. Does not add `maximum-scale=1`, which
 * would be an accessibility regression.
 */
export function renderAdminPage(opts: RenderAdminPageOptions): string {
  const bodyTag = opts.bodyClass
    ? `<body class="${opts.bodyClass}">`
    : "<body>";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${escapeHtml(opts.title)}</title>
  <style>${baseStyles()}${opts.extraStyles ?? ""}</style>${opts.headExtra ? `\n  ${opts.headExtra}` : ""}
</head>
${bodyTag}
  ${opts.body}${opts.bodyEnd ? `\n  ${opts.bodyEnd}` : ""}
</body>
</html>`;
}
