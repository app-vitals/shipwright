import { expect, test } from "@playwright/test";
import { expectNoRuntimeJsBeyondAnalytics } from "./helpers";

// Fulfill external font CDN requests immediately so the page's 'load' event
// fires even when CI can't reach external networks.
test.beforeEach(async ({ page }) => {
  await page.route(
    /fonts\.googleapis\.com|fonts\.gstatic\.com|api\.fontshare\.com|googletagmanager\.com/,
    (route) =>
      route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
});

// /compare smoke tests — the one page that names other tools (the homepage
// #differentiators stays competitor-free; this page is the deliberate exception).

test("compare route responds 200", async ({ page }) => {
  const response = await page.goto("/compare");
  expect(response?.status()).toBe(200);
});

test("compare page leads with the comparison heading", async ({ page }) => {
  await page.goto("/compare");
  await expect(
    page.getByRole("heading", { name: /How Shipwright compares/i }).first(),
  ).toBeVisible();
});

test("compare page ships no runtime JS beyond the analytics tag", async ({
  page,
}) => {
  await page.goto("/compare");
  await expectNoRuntimeJsBeyondAnalytics(page);
});

test("landscape table names the commercial tier", async ({ page }) => {
  await page.goto("/compare");
  // New commercial-tier competitors must appear
  for (const tool of [
    "Devin",
    "Cursor",
    "GitHub Copilot Agent",
    "OpenHands",
    "Augment Code",
    "Shipwright Harness",
  ]) {
    await expect(page.getByText(tool, { exact: false }).first()).toBeVisible();
  }
  const tableText =
    (await page.locator("table").first().textContent()) ?? "";
  expect(tableText).not.toContain("Cline");
  expect(tableText).not.toContain("Aider");
  expect(tableText).not.toContain("Goose");
  expect(tableText).not.toContain("Continue");
  expect(tableText).not.toContain("Kilo Code");
});

test("market structure section is present with 3 poles", async ({ page }) => {
  await page.goto("/compare");
  // Section heading
  await expect(
    page
      .getByRole("heading", { name: /market structure|where tools sit/i })
      .first(),
  ).toBeVisible();
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  // Three poles
  expect(text).toContain("individual copilot");
  expect(text).toContain("team ai workflow");
  expect(text).toContain("autonomous agent");
  // Shipwright positioned in the middle
  expect(text).toContain("shipwright");
});

test("table includes team-relevant capability columns", async ({ page }) => {
  await page.goto("/compare");
  const tableText =
    (await page.locator("table").first().textContent())?.toLowerCase() ?? "";
  // At least 5 new team-relevant dimensions beyond License/Models
  expect(tableText).toContain("task queue");
  expect(tableText).toContain("team visibility");
  expect(tableText).toContain("policy controls");
  expect(tableText).toContain("human review");
  expect(tableText).toContain("cron");
});

test("Devin head-to-head is present and fair", async ({ page }) => {
  await page.goto("/compare");
  await expect(
    page.getByRole("heading", { name: /Shipwright vs Devin/i }),
  ).toBeVisible();
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  // Must have choose-Devin-when framing (honest, not dismissive)
  expect(text).toContain("choose devin");
  // Must have choose-shipwright-when framing
  expect(text).toContain("choose shipwright");
});

test("customizability section is present", async ({ page }) => {
  await page.goto("/compare");
  await expect(
    page
      .getByRole("heading", { name: /customiz/i })
      .first(),
  ).toBeVisible();
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  // Should mention that defaults are swappable / customizable
  expect(text).toContain("opinionated");
  expect(text).toContain("customiz");
});

test("page is honest — it does NOT claim an empty category and does NOT overstate lock-in", async ({
  page,
}) => {
  await page.goto("/compare");
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  // Honesty guardrails from the competitive research.
  expect(text).toContain("table-stakes");
  expect(text).toContain("contested");
  // The Claude-native trade-off is stated plainly, not hidden.
  expect(text).toContain("claude code only");
});

test("self-host section covers Kubernetes / Helm and the open-source own-it angle", async ({
  page,
}) => {
  await page.goto("/compare");
  await expect(
    page.getByRole("heading", { name: /Self-host it/i }),
  ).toBeVisible();
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  expect(text).toContain("kubernetes");
  expect(text).toContain("helm");
  expect(text).toContain("mit-licensed");
  // The actual Helm install command is shown.
  await expect(
    page.getByText("helm install shipwright shipwright/shipwright", {
      exact: false,
    }),
  ).toBeVisible();
});

test("focused OpenHands head-to-head is present and fair", async ({ page }) => {
  await page.goto("/compare");
  await expect(
    page.getByRole("heading", { name: /Shipwright vs OpenHands/i }),
  ).toBeVisible();
  // It credits OpenHands as the category leader (fair framing).
  await expect(page.getByText(/category leader/i).first()).toBeVisible();
});

test("focused Augment Code head-to-head is present and fair", async ({
  page,
}) => {
  await page.goto("/compare");
  await expect(
    page.getByRole("heading", { name: /Shipwright vs Augment Code/i }),
  ).toBeVisible();
  const text = (await page.locator("main").textContent())?.toLowerCase() ?? "";
  expect(text).toContain("choose augment code");
  expect(text).toContain("choose shipwright");
});

test("CTA repeats the install command and links GitHub + discovery call", async ({
  page,
}) => {
  await page.goto("/compare");
  await expect(
    page.getByText("/plugin install shipwright@app-vitals/shipwright", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /github/i }).first(),
  ).toHaveAttribute("href", /github\.com\/app-vitals\/shipwright/);
  await expect(
    page.getByRole("link", { name: /discovery call/i }),
  ).toHaveAttribute("href", "https://cal.com/team/app-vitals/discovery-call");
});

test("compare page markets no pricing", async ({ page }) => {
  await page.goto("/compare");
  const text = (await page.locator("body").textContent()) ?? "";
  const lower = text.toLowerCase();
  for (const term of [
    "pricing",
    "per month",
    "per seat",
    "/month",
    "/mo",
    "subscription",
    "free trial",
  ]) {
    expect(lower).not.toContain(term);
  }
  expect(text).not.toMatch(/\$\d/);
});

test("footer nav links to /compare", async ({ page }) => {
  await page.goto("/");
  const footer = page.locator("footer");
  await expect(
    footer.getByRole("link", { name: /^Compare$/i }),
  ).toHaveAttribute("href", "/compare");
});

test("header nav links to /compare on every page", async ({ page }) => {
  for (const route of ["/", "/compare"]) {
    await page.goto(route);
    const header = page.locator("header");
    await expect(
      header.getByRole("link", { name: /^Compare$/i }),
    ).toHaveAttribute("href", "/compare");
  }
});

test("homepage differentiators bridge into /compare (competitor-free)", async ({
  page,
}) => {
  await page.goto("/");
  const link = page
    .locator("#differentiators")
    .getByRole("link", { name: /how Shipwright compares/i });
  await expect(link).toHaveAttribute("href", "/compare");
  // The homepage bridge must not name competitors (that rule is page-specific).
  await expect(link).not.toHaveText(/openhands|cline|aider|goose|continue|kilo/i);
});
