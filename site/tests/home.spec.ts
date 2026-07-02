import { expect, test } from "@playwright/test";
import { expectNoRuntimeJsBeyondAnalytics } from "./helpers";

// Fulfill external font CDN requests immediately so the page's 'load' event
// fires even when CI can't reach external networks (fonts.googleapis.com, fontshare.com).
test.beforeEach(async ({ page }) => {
  await page.route(
    /fonts\.googleapis\.com|fonts\.gstatic\.com|api\.fontshare\.com|googletagmanager\.com/,
    (route) =>
      route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
});

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
  await expect(heading).toContainText(/own environment/i);
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

test("home ships no runtime JS beyond the GA4 analytics tag", async ({
  page,
}) => {
  await page.goto("/");
  await expectNoRuntimeJsBeyondAnalytics(page);
});

test("GA4 analytics tag is wired with the measurement ID", async ({ page }) => {
  await page.goto("/");
  // The async gtag.js loader for our GA4 stream.
  await expect(
    page.locator(
      'head script[src*="googletagmanager.com/gtag/js?id=G-WS5TVR713J"]',
    ),
  ).toHaveCount(1);
  // The inline config references the same measurement ID.
  const inline = (
    await page.locator("head script:not([src])").allTextContents()
  ).join("\n");
  expect(inline).toContain("G-WS5TVR713J");
  expect(inline).toContain("gtag(");
});

test("robots.txt allows crawling and points at the sitemap", async ({
  page,
}) => {
  const res = await page.request.get("/robots.txt");
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toMatch(/User-agent:\s*\*/i);
  expect(body).toMatch(
    /Sitemap:\s*https:\/\/shipwrightharness\.com\/sitemap-index\.xml/i,
  );
});

test("home embeds JSON-LD structured data (SoftwareApplication + Organization)", async ({
  page,
}) => {
  await page.goto("/");
  const ld = await page
    .locator('head script[type="application/ld+json"]')
    .textContent();
  expect(ld).toBeTruthy();
  const data = JSON.parse(ld ?? "{}");
  const types = (data["@graph"] ?? []).map((n) => n["@type"]);
  expect(types).toContain("SoftwareApplication");
  expect(types).toContain("Organization");
});

test("head wires og:image:alt and twitter:image:alt", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.locator('head meta[property="og:image:alt"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('head meta[name="twitter:image:alt"]'),
  ).toHaveCount(1);
});

// SWW-2.1: Hero. The hero contains the eyebrow, brand tagline, and a two-path CTA
// (install snippet + discovery call link). Tests below scope to page.locator("section").first()
// to guard the hero specifically; lower sections (social-proof, footer) are covered separately.

test("eyebrow features 'Built on Claude Code'", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Built on Claude Code/i).first()).toBeVisible();
});

test("hero features the intro video as its centerpiece", async ({ page }) => {
  await page.goto("/");
  const hero = page.locator("section").first();
  // The hero leads with the intro video (autoplay/muted/loop), not CTA cards.
  await expect(
    hero.locator('video[src="/shipwright-intro.mp4"]'),
  ).toBeVisible();
});

test("page does NOT contain the string 'Autonomous programming, installed'", async ({
  page,
}) => {
  await page.goto("/");
  const text = (await page.locator("body").textContent()) ?? "";
  expect(text).not.toContain("Autonomous programming, installed");
});

test("'Inside a task' tab details the dev-task steps in order", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator('label[for="sw-tab-devtask"]').click();
  const panel = page.locator("#devtask");
  await expect(panel).toBeVisible();
  // The enforced ordering is called out.
  await expect(panel.getByText(/tests before code/i)).toBeVisible();
  // The walkthrough video sits above the step list.
  const video = panel.locator('video[src="/inside-a-task.mp4"]');
  await expect(video).toBeVisible();
  // Video's wrapper precedes the ordered step list in the DOM.
  await expect(
    panel.locator('div:has(> video[src="/inside-a-task.mp4"]) ~ ol'),
  ).toHaveCount(1);
  // First and last steps render, numbered.
  await expect(panel.getByText(/Pick the next task/i)).toBeVisible();
  await expect(panel.getByText(/Push & open the PR/i)).toBeVisible();
  await expect(panel.getByText(/Record metrics & hand off/i)).toBeVisible();
  // All fourteen steps are listed.
  await expect(panel.locator("ol > li")).toHaveCount(14);
});

// Tabbed showcase: one block, five panels, CSS-only switching (no JS).

test("showcase tabs switch panels with zero runtime JS", async ({ page }) => {
  await page.goto("/");
  const showcase = page.locator("#showcase");
  await expect(showcase).toBeVisible();
  // Six tabs present.
  for (const tab of [
    "Two ways to run it",
    "Inside a task",
    "Ships on a schedule",
    "Metrics",
    "Proof",
    "Run the full stack",
  ]) {
    await expect(
      showcase.locator("label.sw-tab", { hasText: tab }),
    ).toBeVisible();
  }
  // Default panel is "Two ways"; the others are hidden until selected.
  await expect(page.locator("#two-ways")).toBeVisible();
  await expect(page.locator("#metrics")).toBeHidden();
  // Selecting a tab reveals its panel and hides the previous one.
  await page.locator('label[for="sw-tab-metrics"]').click();
  await expect(page.locator("#metrics")).toBeVisible();
  await expect(page.locator("#two-ways")).toBeHidden();
  // Tabs switch via CSS :checked — no app JS beyond the analytics tag.
  await expectNoRuntimeJsBeyondAnalytics(page);
});

// Brand lockup: header mark + wordmark, and the favicon wiring.

test("header shows the brand lockup (ship mark + wordmark) linking home", async ({
  page,
}) => {
  await page.goto("/");
  const header = page.locator("header");
  await expect(header).toBeVisible();
  const home = header.getByRole("link", { name: /Shipwright Harness/i });
  await expect(home).toHaveAttribute("href", "/");
  // The ship mark renders as an <img> inside the home link.
  await expect(home.locator("img")).toBeVisible();
});

test("header nav surfaces the Docs link", async ({ page }) => {
  await page.goto("/");
  const nav = page.locator("header nav");
  await expect(
    nav.getByRole("link", { name: /Docs/i }),
  ).toHaveAttribute("href", "/docs");
});

test("mobile hamburger toggle is present", async ({ page }) => {
  await page.goto("/");
  // CSS-only mobile nav uses a hidden checkbox toggle.
  const toggle = page.locator('input[type="checkbox"][id="nav-mobile-toggle"]');
  await expect(toggle).toHaveCount(1);
});

test("favicon wires the scalable ship mark", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.locator('head link[rel="icon"][type="image/svg+xml"]'),
  ).toHaveAttribute("href", "/shipwright-icon.svg");
  // And the asset is actually served (not a 404).
  const res = await page.request.get("/shipwright-icon.svg");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("svg");
});

// Two-pillar section: the plugin (in Claude Code) and the cloud agent (in Slack).

test("two-ways section presents both the plugin and the cloud agent pillars", async ({
  page,
}) => {
  await page.goto("/");
  const section = page.locator("#two-ways");
  await expect(section).toBeVisible();
  // Pillar 1 — the plugin, driven from Claude Code.
  await expect(section.getByText(/in Claude Code/i).first()).toBeVisible();
  // Pillar 2 — the cloud agent: Slack-native and cron-driven.
  await expect(section.getByText(/in your cloud/i).first()).toBeVisible();
  await expect(section.getByText(/Slack/i).first()).toBeVisible();
  await expect(section.getByText(/cron/i).first()).toBeVisible();
});

test("metrics section renders real proof-dashboard figures", async ({ page }) => {
  await page.goto("/");
  // The metrics panel lives behind the "Metrics" tab.
  await page.locator('label[for="sw-tab-metrics"]').click();
  const section = page.locator("#metrics");
  await expect(section).toBeVisible();
  await expect(section.getByRole("heading", { level: 2 })).toBeVisible();
  // The dashboard mock is labelled for a11y as real (live) data for this repo.
  await expect(
    section.getByRole("img", { name: /metrics for this repo/i }),
  ).toBeVisible();
  // Headline metric names appear.
  await expect(section.getByText(/cycle time/i).first()).toBeVisible();
  await expect(section.getByText(/ship-it rate/i).first()).toBeVisible();
  // The figures are sourced from the public proof dashboard, not illustrative.
  await expect(section.getByText(/Real figures for this repo/i)).toBeVisible();
});

test("crons section documents the ten default scheduled jobs", async ({
  page,
}) => {
  await page.goto("/");
  // The crons panel lives behind the "Ships on a schedule" tab.
  await page.locator('label[for="sw-tab-crons"]').click();
  const section = page.locator("#crons");
  await expect(section).toBeVisible();
  // All ten system crons (admin/src/system-crons.ts) are named.
  for (const name of [
    "dev-task",
    "review-patch",
    "review",
    "patch",
    "deploy",
    "test-readiness",
    "docs-freshness",
    "learn-dream",
    "dependabot-triage",
    "entropy-patrol",
  ]) {
    await expect(
      section.getByText(name, { exact: false }).first(),
    ).toBeVisible();
  }
  // Exactly two run on by default; the rest are opt-in.
  await expect(section.getByText("On", { exact: true })).toHaveCount(2);
  await expect(section.getByText("Opt-in", { exact: true })).toHaveCount(8);
});

// SWW-2.2: Body sections (problem / how-it-works / differentiators / demo / social proof).

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

test("'Run the full stack' tab shows the task stack:up walkthrough video", async ({
  page,
}) => {
  await page.goto("/");
  // The walkthrough panel lives behind the "Run the full stack" tab (id #demo).
  await page.locator('label[for="sw-tab-demo"]').click();
  const demo = page.locator("#demo");
  await expect(demo).toBeVisible();
  await expect(
    demo.locator('video[src="/task-stack-up-walkthrough.mp4"]'),
  ).toBeVisible();
  await expect(demo.getByText(/task stack:up/i).first()).toBeVisible();
  // Native <video>, no injected player — no app JS beyond the analytics tag.
  await expectNoRuntimeJsBeyondAnalytics(page);
});

test("'Proof' tab makes the dogfooding case and links to the public dashboard", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator('label[for="sw-tab-proof"]').click();
  const proof = page.locator("#proof");
  await expect(proof).toBeVisible();
  await expect(
    proof.getByRole("heading", { name: /Shipwright builds Shipwright/i }),
  ).toBeVisible();
  // Primary CTA → the live public dashboard.
  await expect(
    proof.getByRole("link", { name: /live dashboard/i }),
  ).toHaveAttribute(
    "href",
    "https://proof.shipwrightharness.com/public/dashboard",
  );
  // Secondary CTA → the public task queue.
  await expect(
    proof.getByRole("link", { name: /task queue/i }),
  ).toHaveAttribute("href", "https://proof.shipwrightharness.com/public/tasks");
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
