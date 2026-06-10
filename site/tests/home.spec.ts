import { expect, test } from "@playwright/test";

// Smoke test for the Shipwright Harness marketing site (SWW-1.1).
// Relies on playwright.config.ts `webServer` to build + preview the site.

test("home route responds 200", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
});

test("hero heading renders the brand tagline", async ({ page }) => {
  await page.goto("/");
  const heading = page.locator("h1");
  await expect(heading).toBeVisible();
  await expect(heading).toContainText(/autonomous delivery agent/i);
});

test("dark-premium navy base background is applied", async ({ page }) => {
  await page.goto("/");
  // brand.css sets body background to --sw-color-bg-base (#080E1E => rgb(8, 14, 30)).
  const bg = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  expect(bg).toBe("rgb(8, 14, 30)");
  // The brand CSS variable must be present on :root.
  const baseVar = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--sw-color-bg-base")
      .trim(),
  );
  expect(baseVar.toUpperCase()).toBe("#080E1E");
});

test("home document ships NO runtime JS (zero <script> tags)", async ({
  page,
}) => {
  await page.goto("/");
  const scriptCount = await page.locator("script").count();
  expect(scriptCount).toBe(0);
});

// SWW-2.1: Hero + install section.

test("primary 'Get started' CTA renders", async ({ page }) => {
  await page.goto("/");
  // The hero CTA is the first "Get started" link on the page.
  const cta = page.getByRole("link", { name: "Get started" }).first();
  await expect(cta).toBeVisible();
  await expect(cta).toHaveAttribute("href", "#install");
});

test("exact install command string renders", async ({ page }) => {
  await page.goto("/");
  // The hero install block has id="install" — use that to scope.
  await expect(
    page
      .locator("#install")
      .getByText("/plugin install shipwright@app-vitals/shipwright", {
        exact: true,
      }),
  ).toBeVisible();
});

test("secondary 'View on GitHub' CTA points at the repo", async ({ page }) => {
  await page.goto("/");
  const cta = page.getByRole("link", { name: "View on GitHub" });
  await expect(cta).toBeVisible();
  await expect(cta).toHaveAttribute(
    "href",
    "https://github.com/app-vitals/shipwright",
  );
});

test("eyebrow features 'Built on Claude Code'", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Built on Claude Code/i).first()).toBeVisible();
});

// SWW-2.2: Body sections (problem / how-it-works / differentiators / demo / social proof).

test("problem section renders its headline", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /pipeline isn't/i }),
  ).toBeVisible();
});

test("how-it-works leads with the agent and never headlines 'the loop'", async ({
  page,
}) => {
  await page.goto("/");
  const section = page.locator("#how-it-works");
  await expect(section).toBeVisible();
  // Positively features the deployable agent.
  await expect(section.getByText(/deployable agent/i).first()).toBeVisible();
  // Brand rule: the section heading must NOT market "the loop" / "the delivery loop".
  const heading = section.getByRole("heading").first();
  await expect(heading).not.toHaveText(/the (delivery )?loop/i);
});

test("how-it-works presents all four pipeline stages", async ({ page }) => {
  await page.goto("/");
  const section = page.locator("#how-it-works");
  for (const stage of ["Plan", "Build", "Review", "Ship"]) {
    await expect(
      section.getByText(new RegExp(`^${stage}$`, "i")).first(),
    ).toBeVisible();
  }
});

test("differentiators feature 'Built on Claude Code' and free/open-source (MIT)", async ({
  page,
}) => {
  await page.goto("/");
  const section = page.locator("#differentiators");
  await expect(section).toBeVisible();
  await expect(
    section.getByText(/Built on Claude Code/i).first(),
  ).toBeVisible();
  await expect(section.getByText(/open[- ]source/i).first()).toBeVisible();
  await expect(section.getByText(/MIT/).first()).toBeVisible();
});

test("differentiators name no competitors", async ({ page }) => {
  await page.goto("/");
  const text =
    (await page.locator("#differentiators").textContent())?.toLowerCase() ?? "";
  for (const competitor of [
    "devin",
    "cursor",
    "copilot",
    "windsurf",
    "github copilot",
  ]) {
    expect(text).not.toContain(competitor);
  }
});

test("demo renders a static terminal block with no runtime JS", async ({
  page,
}) => {
  await page.goto("/");
  const demo = page.locator("#demo");
  await expect(demo).toBeVisible();
  await expect(demo.locator("pre, code").first()).toBeVisible();
  await expect(demo.getByText(/dev-task/i).first()).toBeVisible();
  // Reconfirm zero runtime JS (no asciinema player injected).
  expect(await page.locator("script").count()).toBe(0);
});

test("social proof links to GitHub and repeats the install command", async ({
  page,
}) => {
  await page.goto("/");
  const section = page.locator("#social-proof");
  await expect(section).toBeVisible();
  await expect(
    section.getByRole("link", { name: /github/i }).first(),
  ).toHaveAttribute("href", /github\.com\/app-vitals\/shipwright/);
  await expect(
    section.getByText("/plugin install shipwright@app-vitals/shipwright", {
      exact: true,
    }),
  ).toBeVisible();
});

// SWW-2.3: Services bridge (COSS) + site footer.

test("services bridge links to the discovery call", async ({ page }) => {
  await page.goto("/");
  const section = page.locator("#services");
  await expect(section).toBeVisible();
  await expect(
    section.getByRole("link", { name: /discovery call/i }),
  ).toHaveAttribute("href", "https://cal.com/app-vitals/discovery");
});

test("services bridge stays soft — no email-capture form", async ({ page }) => {
  await page.goto("/");
  const section = page.locator("#services");
  // COSS bridge is a single off-page CTA, not a lead-gen form.
  expect(await section.locator("form, input").count()).toBe(0);
});

test("footer links to repo, license (MIT), Claude Code, and community", async ({
  page,
}) => {
  await page.goto("/");
  const footer = page.locator("footer");
  await expect(footer).toBeVisible();
  // Repository.
  await expect(
    footer.getByRole("link", { name: "GitHub", exact: true }),
  ).toHaveAttribute("href", "https://github.com/app-vitals/shipwright");
  // License (MIT).
  await expect(
    footer.getByRole("link", { name: /MIT License/i }),
  ).toHaveAttribute("href", /LICENSE/);
  // Claude Code — the platform, featured (never a competitor).
  await expect(
    footer.getByRole("link", { name: /Claude Code/i }),
  ).toHaveAttribute("href", "https://claude.com/claude-code");
  // Community — GitHub Discussions.
  await expect(
    footer.getByRole("link", { name: /GitHub Discussions/i }),
  ).toHaveAttribute("href", /github\.com\/app-vitals\/shipwright\/discussions/);
});

// SWW-3.1: OG/social image + head meta.

test("head wires an absolute og:image (1280x640) for link previews", async ({
  page,
}) => {
  await page.goto("/");
  // Link-preview crawlers reject relative URLs — og:image must be absolute.
  const absolutePng = /^https:\/\/shipwrightharness\.com\/.+\.png$/;
  await expect(page.locator('head meta[property="og:image"]')).toHaveAttribute(
    "content",
    absolutePng,
  );
  await expect(
    page.locator('head meta[property="og:image:width"]'),
  ).toHaveAttribute("content", "1280");
  await expect(
    page.locator('head meta[property="og:image:height"]'),
  ).toHaveAttribute("content", "640");
  await expect(page.locator('head meta[name="twitter:image"]')).toHaveAttribute(
    "content",
    absolutePng,
  );
});

test("head wires a canonical URL", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('head link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://shipwrightharness.com/",
  );
});

test("the og:image asset is actually served (1280x640 PNG)", async ({
  page,
}) => {
  // The og:image points at the production origin; locally the same path is
  // served by the preview server. A 200 PNG proves the asset is committed and
  // a link-preview check would resolve it (not a 404).
  const res = await page.request.get("/og-default-1280x640.png");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("image/png");
});

test("page markets no pricing anywhere", async ({ page }) => {
  await page.goto("/");
  const text = (await page.locator("body").textContent()) ?? "";
  const lower = text.toLowerCase();
  for (const term of [
    "pricing",
    "per month",
    "per seat",
    "per user",
    "/month",
    "/mo",
    "subscription",
    "free trial",
    "billed annually",
  ]) {
    expect(lower).not.toContain(term);
  }
  // No dollar-amount price tags. The demo transcript uses "$ " shell prompts
  // (dollar + space), never "$<digit>", so this only catches real prices.
  expect(text).not.toMatch(/\$\d/);
});
