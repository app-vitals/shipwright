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

// Assert no real dollar-amount price tag ("$" immediately followed by a
// digit) appears in the page body. Demo transcripts use "$ " shell prompts
// (dollar + space), which do not match, so this only catches actual prices.
export async function expectNoDollarFigures(page: Page): Promise<void> {
  const text = (await page.locator("body").textContent()) ?? "";
  expect(text).not.toMatch(/\$\d/);
}

// Assert none of the given phrases appear anywhere in the page body,
// case-insensitively. Used to enforce copy-policy bans (e.g. no pricing
// language) across multiple pages without duplicating the phrase-scan logic.
export async function expectBannedPhrasesAbsent(
  page: Page,
  phrases: string[],
): Promise<void> {
  const text = (await page.locator("body").textContent()) ?? "";
  const lower = text.toLowerCase();
  for (const phrase of phrases) {
    expect(lower).not.toContain(phrase.toLowerCase());
  }
}
