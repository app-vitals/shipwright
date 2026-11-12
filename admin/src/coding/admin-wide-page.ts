/**
 * Shared full-width override for admin pages with wide tables.
 *
 * agent-lib's `.vos-page` caps the body at max-width:960px. `.admin-wide-page`
 * has equal specificity and wins the tie because extraStyles renders after
 * baseStyles(). The @media (max-width:640px) padding rule for `.vos-page` is
 * untouched. Form-only pages (e.g. Notification Settings) must not use it.
 */
export const ADMIN_WIDE_PAGE_CLASS = "admin-wide-page";

export const ADMIN_WIDE_PAGE_STYLES = `.${ADMIN_WIDE_PAGE_CLASS} { max-width:none;width:100% }`;
