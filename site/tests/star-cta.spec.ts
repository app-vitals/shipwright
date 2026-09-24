import { expect, test } from "@playwright/test";
import { REPO_URL } from "../src/consts";

// STAR-1.1: the star conversion path — a hero CTA, a build-time star count,
// a desktop-visible docs CTA, and UTM-tagged repo links throughout. See
// brand/MESSAGING.md-adjacent context in the task brief for why: the site
// barely asked for the star before this.

test.beforeEach(async ({ page }) => {
  await page.route(
    /fonts\.googleapis\.com|fonts\.gstatic\.com|api\.fontshare\.com|googletagmanager\.com/,
    (route) =>
      route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
});

// A repo link carries the STAR-1.1 UTM scheme: source/medium/campaign fixed,
// utm_content varying by placement.
function repoLinkPattern(content: string): RegExp {
  return new RegExp(
    `^${REPO_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?.*utm_source=shipwrightharness\\.com.*utm_medium=site.*utm_campaign=star_cta.*utm_content=${content}`,
  );
}

// ---- (A) Homepage hero star CTA ----

test("homepage hero contains a star CTA, visible above the fold, with UTM tagging", async ({
  page,
}) => {
  await page.goto("/");
  const hero = page.locator("section").first();
  const cta = hero.getByRole("link", { name: /star.*github/i });
  await expect(cta).toBeVisible();
  await expect(cta).toBeInViewport();
  const href = await cta.getAttribute("href");
  expect(href).toMatch(repoLinkPattern("hero"));
});

// ---- (B) Build-time star count with gating + reserved layout space ----

test("homepage reserves layout space for a star count next to the hero CTA", async ({
  page,
}) => {
  await page.goto("/");
  const slot = page.getByTestId("hero-star-count");
  await expect(slot).toHaveCount(1);
  // Space is reserved regardless of whether a number renders (no CLS).
  const minWidth = await slot.evaluate(
    (el) => getComputedStyle(el).minWidth,
  );
  expect(minWidth).not.toBe("0px");
  const text = (await slot.textContent())?.trim() ?? "";
  // Either empty (below MIN_STARS_TO_DISPLAY) or a formatted count of
  // stars — never raw digits with no gating logic applied.
  if (text.length > 0) {
    expect(text).toMatch(/^[\d,]+\s*stars?$/i);
  }
});

test("homepage still ships no new script tag for the star count fetch", async ({
  page,
}) => {
  await page.goto("/");
  // The star count is fetched at Astro build/frontmatter time only —
  // confirmed by the absence of any script tag beyond the existing
  // GA4 + JSON-LD allowance (see helpers.expectNoRuntimeJsBeyondAnalytics,
  // exercised directly by home.spec.ts). Belt-and-suspenders check here:
  // no script tag mentions the GitHub API or "stargazers".
  const scripts = await page.locator("script").allTextContents();
  const joined = scripts.join("\n");
  expect(joined).not.toContain("api.github.com");
  expect(joined).not.toContain("stargazers");
});

// ---- Existing social-proof CTA keeps its star wording and gains UTM tagging ----

test("social-proof GitHub CTA keeps 'Star on GitHub' wording and gains UTM tagging", async ({
  page,
}) => {
  await page.goto("/");
  const section = page.locator("#social-proof");
  const cta = section.getByRole("link", { name: /star on github/i });
  await expect(cta).toBeVisible();
  const href = await cta.getAttribute("href");
  expect(href).toMatch(repoLinkPattern("social_proof"));
});

// ---- (E) AC5: every site->repo link carries UTM parameters ----
// The global nav header, the mobile nav panel, the footer, and the docs
// sidebar all linked bare REPO_URL before this. AC5 is "all site->repo links
// carry UTM parameters", so assert the absence of the bare form directly
// rather than only spot-checking the CTAs.

test("global nav header GitHub link is UTM-tagged", async ({ page }) => {
  await page.goto("/");
  const link = page
    .locator("header")
    .getByRole("link", { name: /github/i })
    .first();
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  expect(href).toMatch(repoLinkPattern("nav_header"));
});

test("mobile nav panel GitHub link is UTM-tagged", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  // The panel is closed (and so hidden from the accessibility tree) until the
  // toggle is tapped, so locate by CSS rather than by role — this assertion is
  // about the href, not about visibility.
  const link = page
    .locator(`#mobile-nav-panel a[href^="${REPO_URL}?"]`)
    .first();
  await expect(link).toHaveCount(1);
  const href = await link.getAttribute("href");
  expect(href).toMatch(repoLinkPattern("nav_header_mobile"));
});

test("site footer GitHub link is UTM-tagged", async ({ page }) => {
  await page.goto("/");
  const link = page
    .locator("footer")
    .getByRole("link", { name: "GitHub", exact: true });
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  expect(href).toMatch(repoLinkPattern("nav_footer"));
});

test("docs mobile sidebar GitHub link is UTM-tagged", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/docs/introduction");
  const link = page
    .locator("aside.docs-sidebar")
    .locator("a.docs-sidebar-link")
    .filter({ hasText: /github/i })
    .first();
  const href = await link.getAttribute("href");
  expect(href).toMatch(repoLinkPattern("docs_sidebar"));
});

// The catch-all: no anchor anywhere on these pages points at a bare,
// untagged REPO_URL. Guards against a future placement reintroducing one.
for (const route of ["/", "/docs/introduction"]) {
  test(`${route} has no bare untagged REPO_URL link`, async ({ page }) => {
    await page.goto(route);
    await expect(page.locator(`a[href="${REPO_URL}"]`)).toHaveCount(0);
    await expect(page.locator(`a[href="${REPO_URL}/"]`)).toHaveCount(0);

    // And every repo link that *is* present carries the full UTM scheme.
    const hrefs = await page
      .locator(`a[href^="${REPO_URL}?"]`)
      .evaluateAll((els) =>
        els.map((el) => (el as HTMLAnchorElement).getAttribute("href") ?? ""),
      );
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      const params = new URL(href).searchParams;
      expect(params.get("utm_source")).toBe("shipwrightharness.com");
      expect(params.get("utm_medium")).toBe("site");
      expect(params.get("utm_campaign")).toBe("star_cta");
      expect(params.get("utm_content")).toBeTruthy();
    }
  });
}

// ---- (C) /docs/introduction desktop-visible star CTA ----

test("/docs/introduction presents a star CTA visible at desktop widths", async ({
  page,
}) => {
  await page.goto("/docs/introduction");
  const cta = page.getByRole("link", { name: /star.*github/i });
  await expect(cta).toBeVisible();
  const href = await cta.getAttribute("href");
  expect(href).toMatch(repoLinkPattern("docs"));
});

// ---- (D) TryItCta star wording across its six consumers ----

const TRY_IT_CTA_ROUTES = [
  "/vs/devin",
  "/compare",
  "/autonomy",
  "/self-hosted",
  "/vs/factory",
  "/vs/openhands",
];

for (const route of TRY_IT_CTA_ROUTES) {
  test(`${route} TryItCta uses explicit star wording and UTM-tagged href`, async ({
    page,
  }) => {
    await page.goto(route);
    const cta = page.locator("#cta").getByRole("link", { name: /star/i });
    await expect(cta).toBeVisible();
    const href = await cta.getAttribute("href");
    expect(href).toMatch(repoLinkPattern("try_it_cta"));
  });
}

// ---- (F) /vs/openhands keeps its no-star-count-digits guarantee ----
// (Regression guard alongside the pre-existing assertion in
// vs-openhands.spec.ts — TryItCta must never render a bare star number.)

test("/vs/openhands TryItCta never renders a star-count digit", async ({
  page,
}) => {
  await page.goto("/vs/openhands");
  const cta = page.locator("#cta");
  const text = (await cta.textContent()) ?? "";
  expect(text).not.toMatch(/[\d,.]+\s*[kK]?\s*(github )?stars?\b/i);
});
