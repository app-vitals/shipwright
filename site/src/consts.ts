/**
 * Canonical booking destination for the discovery call.
 *
 * Single source of truth — imported by pages, layouts, and the Playwright specs
 * so a URL swap is one line here and the tests cannot drift from the source.
 */
export const BOOKING_URL = "https://vitals-os.com/cal/book/discovery";
