import { expect, type Page } from "@playwright/test";

// Assert a page ships no first-party runtime JS beyond the explicitly allowed
// tags. The marketing pages run zero JS of their own; the only <script> tags
// permitted are:
//   • the GA4 analytics tag — the async gtag.js loader + its inline config
//   • the inert JSON-LD structured-data block (data, not executable)
//   • (docs pages only, when allowPagefind) the Pagefind UI search loader
// Anything else — framework hydration, bundled app JS — fails the check.
export async function expectNoRuntimeJsBeyondAnalytics(
  page: Page,
  opts: { allowPagefind?: boolean } = {},
): Promise<void> {
  const { allowPagefind = false } = opts;
  const scripts = await page.locator("script").all();
  for (const s of scripts) {
    const src = await s.getAttribute("src");
    const type = await s.getAttribute("type");
    const body = (await s.textContent()) ?? "";
    const isGtagLoader = !!src && src.includes("googletagmanager.com/gtag/js");
    const isGtagConfig = !src && body.includes("gtag(");
    const isJsonLd = type === "application/ld+json";
    const isPagefind = allowPagefind && /pagefind/i.test(`${src ?? ""} ${body}`);
    expect(
      isGtagLoader || isGtagConfig || isJsonLd || isPagefind,
      `unexpected runtime <script> (src=${src ?? "inline"}, type=${type ?? "none"})`,
    ).toBe(true);
  }
}
