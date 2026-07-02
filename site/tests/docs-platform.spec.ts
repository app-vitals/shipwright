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

// Docs platform e2e tests (SD-platform-syntax-theme).
// These tests cover the MDX content collection, DocsLayout, and syntax theme.

test("GET /docs/getting-started returns 200", async ({ page }) => {
  const response = await page.goto("/docs/getting-started");
  expect(response?.status()).toBe(200);
});

test("sidebar is present on docs page", async ({ page }) => {
  await page.goto("/docs/getting-started");
  const sidebar = page.locator("nav[aria-label='Docs navigation']");
  await expect(sidebar).toBeVisible();
});

test("TOC (table of contents) is present on docs page", async ({ page }) => {
  await page.goto("/docs/getting-started");
  const toc = page.locator("nav[aria-label='On this page']");
  await expect(toc).toBeVisible();
});

// prev/next navigation test removed: getting-started.mdx no longer has a `next`
// frontmatter field (configuration.mdx does not exist yet). Re-add once a second
// docs page exists so the nav link can actually render.

test("docs page ships no runtime JS beyond Pagefind + the analytics tag", async ({
  page,
}) => {
  await page.goto("/docs/getting-started");
  await expectNoRuntimeJsBeyondAnalytics(page, { allowPagefind: true });
});

test("sidebar lists at least one docs section", async ({ page }) => {
  await page.goto("/docs/getting-started");
  const sidebar = page.locator("nav[aria-label='Docs navigation']");
  const links = sidebar.locator("a");
  const count = await links.count();
  expect(count).toBeGreaterThan(0);
});

test("TOC lists headings of the current page", async ({ page }) => {
  await page.goto("/docs/getting-started");
  const toc = page.locator("nav[aria-label='On this page']");
  const links = toc.locator("a");
  const count = await links.count();
  expect(count).toBeGreaterThan(0);
});

test("mobile sidebar toggle uses CSS-only checkbox pattern (no inline onclick)", async ({
  page,
}) => {
  await page.goto("/docs/getting-started");
  // The mobile toggle must be a checkbox or label — no onclick attributes
  const interactiveElements = await page
    .locator("[onclick]")
    .count();
  expect(interactiveElements).toBe(0);
  // There must be a checkbox or label for the mobile toggle
  const toggleCheckbox = page.locator(
    "input[type='checkbox']#docs-sidebar-toggle",
  );
  await expect(toggleCheckbox).toHaveCount(1);
});

test("fenced code block is present in getting-started page", async ({
  page,
}) => {
  await page.goto("/docs/getting-started");
  // The MDX page has a bash code block
  const codeBlock = page.locator("pre code");
  await expect(codeBlock.first()).toBeVisible();
});

// Introduction page tests (SD-4.1)

test("GET /docs/introduction returns 200", async ({ page }) => {
  const response = await page.goto("/docs/introduction");
  expect(response?.status()).toBe(200);
});

test("fenced code block is present in introduction page", async ({ page }) => {
  await page.goto("/docs/introduction");
  const codeBlock = page.locator("pre code");
  await expect(codeBlock.first()).toBeVisible();
});

test("key headings visible in introduction page", async ({ page }) => {
  await page.goto("/docs/introduction");
  // At least one h2 heading must be present
  const h2 = page.locator("h2");
  await expect(h2.first()).toBeVisible();
});

test("key headings visible in getting-started page", async ({ page }) => {
  await page.goto("/docs/getting-started");
  // Prerequisites or Getting Started h2 must be present
  const h2 = page.locator("h2");
  await expect(h2.first()).toBeVisible();
  // Specifically check for Prerequisites heading
  const prerequisites = page.locator("h2", { hasText: /prerequisites/i });
  await expect(prerequisites).toBeVisible();
});

test("prev/next navigation links are present on getting-started page", async ({
  page,
}) => {
  await page.goto("/docs/getting-started");
  // Should have a prev link back to introduction
  const prevLink = page.locator("a[data-nav='prev']");
  await expect(prevLink).toBeVisible();
  const href = await prevLink.getAttribute("href");
  expect(href).toBe("/docs/introduction");
});

test("prev/next navigation links are present on introduction page", async ({
  page,
}) => {
  await page.goto("/docs/introduction");
  // Should have a next link to getting-started
  const nextLink = page.locator("a[data-nav='next']");
  await expect(nextLink).toBeVisible();
  const href = await nextLink.getAttribute("href");
  expect(href).toBe("/docs/getting-started");
});

// SD-4.2 — Remaining 5 MDX content sections

test("GET /docs/the-plugin returns 200", async ({ page }) => {
  const response = await page.goto("/docs/the-plugin");
  expect(response?.status()).toBe(200);
});

test("key headings visible in the-plugin page", async ({ page }) => {
  await page.goto("/docs/the-plugin");
  // Must have an h2 heading
  const h2 = page.locator("h2");
  await expect(h2.first()).toBeVisible();
  // Commands heading must be present
  const commandsHeading = page.locator("h2", { hasText: /commands/i });
  await expect(commandsHeading).toBeVisible();
});

test("prev/next navigation links on the-plugin page", async ({ page }) => {
  await page.goto("/docs/the-plugin");
  // prev → getting-started
  const prevLink = page.locator("a[data-nav='prev']");
  await expect(prevLink).toBeVisible();
  expect(await prevLink.getAttribute("href")).toBe("/docs/getting-started");
  // next → running-locally
  const nextLink = page.locator("a[data-nav='next']");
  await expect(nextLink).toBeVisible();
  expect(await nextLink.getAttribute("href")).toBe("/docs/running-locally");
});

test("GET /docs/running-locally returns 200", async ({ page }) => {
  const response = await page.goto("/docs/running-locally");
  expect(response?.status()).toBe(200);
});

test("key headings visible in running-locally page", async ({ page }) => {
  await page.goto("/docs/running-locally");
  const h2 = page.locator("h2");
  await expect(h2.first()).toBeVisible();
  // task stack section heading must be present
  const stackHeading = page.locator("h2", { hasText: /task stack/i });
  await expect(stackHeading).toBeVisible();
});

test("prev/next navigation links on running-locally page", async ({ page }) => {
  await page.goto("/docs/running-locally");
  // prev → the-plugin
  const prevLink = page.locator("a[data-nav='prev']");
  await expect(prevLink).toBeVisible();
  expect(await prevLink.getAttribute("href")).toBe("/docs/the-plugin");
  // next → the-agent
  const nextLink = page.locator("a[data-nav='next']");
  await expect(nextLink).toBeVisible();
  expect(await nextLink.getAttribute("href")).toBe("/docs/the-agent");
});

test("GET /docs/the-agent returns 200", async ({ page }) => {
  const response = await page.goto("/docs/the-agent");
  expect(response?.status()).toBe(200);
});

test("key headings visible in the-agent page", async ({ page }) => {
  await page.goto("/docs/the-agent");
  const h2 = page.locator("h2");
  await expect(h2.first()).toBeVisible();
  // Run modes heading must be present
  const runModesHeading = page.locator("h2", { hasText: /run modes/i });
  await expect(runModesHeading).toBeVisible();
  // Data model heading must be present
  const dataModelHeading = page.locator("h2", { hasText: /data model/i });
  await expect(dataModelHeading).toBeVisible();
});

test("prev/next navigation links on the-agent page", async ({ page }) => {
  await page.goto("/docs/the-agent");
  // prev → running-locally
  const prevLink = page.locator("a[data-nav='prev']");
  await expect(prevLink).toBeVisible();
  expect(await prevLink.getAttribute("href")).toBe("/docs/running-locally");
  // next → configuring-autonomy
  const nextLink = page.locator("a[data-nav='next']");
  await expect(nextLink).toBeVisible();
  expect(await nextLink.getAttribute("href")).toBe("/docs/configuring-autonomy");
});

test("configuring-autonomy page loads and has correct nav links", async ({
  page,
}) => {
  const response = await page.goto("/docs/configuring-autonomy");
  expect(response?.status()).toBe(200);
  // h2 heading must be present
  const h2 = page.locator("h2");
  await expect(h2.first()).toBeVisible();
  // prev → the-agent
  const prevLink = page.locator("a[data-nav='prev']");
  await expect(prevLink).toBeVisible();
  expect(await prevLink.getAttribute("href")).toBe("/docs/the-agent");
  // next → deploying-to-cloud
  const nextLink = page.locator("a[data-nav='next']");
  await expect(nextLink).toBeVisible();
  expect(await nextLink.getAttribute("href")).toBe("/docs/deploying-to-cloud");
});

test("deploying-to-cloud has updated prev/next links", async ({ page }) => {
  await page.goto("/docs/deploying-to-cloud");
  // prev → configuring-autonomy
  const prevLink = page.locator("a[data-nav='prev']");
  await expect(prevLink).toBeVisible();
  expect(await prevLink.getAttribute("href")).toBe("/docs/configuring-autonomy");
  // next → slack-integration (new)
  const nextLink = page.locator("a[data-nav='next']");
  await expect(nextLink).toBeVisible();
  expect(await nextLink.getAttribute("href")).toBe("/docs/slack-integration");
});

test("key headings visible in deploying-to-cloud page", async ({ page }) => {
  await page.goto("/docs/deploying-to-cloud");
  const h2 = page.locator("h2");
  await expect(h2.first()).toBeVisible();
  // Networking model heading must be present
  const networkingHeading = page.locator("h2", { hasText: /networking model/i });
  await expect(networkingHeading).toBeVisible();
  // Minikube heading must be present
  const minikubeHeading = page.locator("h2", { hasText: /minikube/i });
  await expect(minikubeHeading).toBeVisible();
});

test("GET /docs/slack-integration returns 200", async ({ page }) => {
  const response = await page.goto("/docs/slack-integration");
  expect(response?.status()).toBe(200);
});

test("key headings visible in slack-integration page", async ({ page }) => {
  await page.goto("/docs/slack-integration");
  const h2 = page.locator("h2");
  await expect(h2.first()).toBeVisible();
  // Connecting a Slack app heading must be present
  const connectHeading = page.locator("h2", { hasText: /connecting a slack app/i });
  await expect(connectHeading).toBeVisible();
  // Response markers heading must be present
  const markersHeading = page.locator("h2", { hasText: /response markers/i });
  await expect(markersHeading).toBeVisible();
});

test("prev/next navigation on slack-integration page (terminal page)", async ({ page }) => {
  await page.goto("/docs/slack-integration");
  // prev → deploying-to-cloud
  const prevLink = page.locator("a[data-nav='prev']");
  await expect(prevLink).toBeVisible();
  expect(await prevLink.getAttribute("href")).toBe("/docs/deploying-to-cloud");
  // no next link — slack-integration is the terminal page; no broken/empty href allowed
  const nextLink = page.locator("a[data-nav='next']");
  await expect(nextLink).toHaveCount(0);
});

test("mobile sidebar slides in when toggle is tapped", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/docs/getting-started");
  // Sidebar should be off-screen initially
  const sidebar = page.locator("aside.docs-sidebar");
  // Tap the ☰ Menu button
  await page.locator("label[for='docs-sidebar-toggle']").first().click();
  // Sidebar should now be visible (transform: translateX(0))
  await expect(sidebar).toBeVisible();
});

test("mobile sidebar contains Docs, Compare, GitHub nav links", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/docs/getting-started");
  // Open the sidebar
  await page.locator("label[for='docs-sidebar-toggle']").first().click();
  const sidebar = page.locator("aside.docs-sidebar");
  // Nav links should be present in the sidebar
  await expect(sidebar.locator("a[href='/docs']")).toBeVisible();
  await expect(sidebar.locator("a[href='/compare']")).toBeVisible();
  await expect(sidebar.locator("a[href='https://github.com/app-vitals/shipwright']")).toBeVisible();
});

test("sidebar section order: Getting Started appears before Agent", async ({
  page,
}) => {
  await page.goto("/docs/getting-started");
  const sidebar = page.locator("nav[aria-label='Docs navigation']");
  // Get all section labels (the <p class="sw-label"> elements)
  const sectionLabels = sidebar.locator("p.sw-label");
  const allLabels = (await sectionLabels.allTextContents()).map((l) => l.trim());
  // Find indices of "Getting Started" and "Agent" sections
  const gettingStartedIndex = allLabels.indexOf("Getting Started");
  const agentIndex = allLabels.indexOf("Agent");
  // Both should exist and Getting Started should come before Agent
  expect(gettingStartedIndex).toBeGreaterThanOrEqual(0);
  expect(agentIndex).toBeGreaterThanOrEqual(0);
  expect(gettingStartedIndex).toBeLessThan(agentIndex);
});
