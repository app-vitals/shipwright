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

// Slack integration docs page tests

test("GET /docs/slack-integration returns 200", async ({ page }) => {
  const response = await page.goto("/docs/slack-integration");
  expect(response?.status()).toBe(200);
});

test("slack-integration page has h1 heading", async ({ page }) => {
  await page.goto("/docs/slack-integration");
  const h1 = page.locator("h1");
  await expect(h1).toBeVisible();
});

// SUX-2.2 — "Connecting a Slack app" now uses StepFlow instead of nested
// numbered lists, with the Socket Mode step visually flagged as manual.

test("Connecting a Slack app section renders as a step flow", async ({
  page,
}) => {
  await page.goto("/docs/slack-integration");
  const heading = page.locator("h2, h3", {
    hasText: /connecting a slack app/i,
  });
  await expect(heading.first()).toBeVisible();

  const stepFlow = heading
    .first()
    .locator("xpath=following::ol[contains(@class, 'step-flow')][1]");
  await expect(stepFlow).toBeVisible();

  const steps = stepFlow.locator("li.step-flow-item");
  await expect(steps).toHaveCount(4);
});

test("Connecting a Slack app section flags the Socket Mode step as manual", async ({
  page,
}) => {
  await page.goto("/docs/slack-integration");
  const heading = page.locator("h2, h3", {
    hasText: /connecting a slack app/i,
  });
  const stepFlow = heading
    .first()
    .locator("xpath=following::ol[contains(@class, 'step-flow')][1]");

  const socketModeStep = stepFlow.locator("li.step-flow-item", {
    hasText: /socket mode/i,
  });
  await expect(socketModeStep.first()).toBeVisible();

  const manualTag = socketModeStep.first().locator(".step-manual-tag");
  await expect(manualTag).toBeVisible();
  await expect(manualTag).toHaveText(/manual step/i);

  const manualBox = socketModeStep.first().locator(".step-box-manual");
  await expect(manualBox).toBeVisible();
});

test("Connecting a Slack app section preserves all credential/token names", async ({
  page,
}) => {
  await page.goto("/docs/slack-integration");
  const heading = page.locator("h2, h3", {
    hasText: /connecting a slack app/i,
  });
  // Scope to everything between this h2 and the next h2 (the credential
  // table section), so token names in later unrelated sections don't
  // false-positive this check.
  const nextHeading = page.locator("h2", {
    hasText: /required slack environment variables/i,
  });
  const text =
    (await page.evaluate(
      ([startText, endText]) => {
        const headings = Array.from(document.querySelectorAll("h2, h3"));
        const start = headings.find((h) =>
          (h.textContent ?? "")
            .toLowerCase()
            .includes((startText as string).toLowerCase()),
        );
        const end = headings.find((h) =>
          (h.textContent ?? "")
            .toLowerCase()
            .includes((endText as string).toLowerCase()),
        );
        if (!start || !end) return "";
        let node: Element | null = start.nextElementSibling;
        let out = "";
        while (node && node !== end) {
          out += node.textContent ?? "";
          node = node.nextElementSibling;
        }
        return out;
      },
      ["Connecting a Slack app", "Required Slack environment variables"],
    )) ?? "";

  expect(text).toContain("xoxe.xoxp-");
  expect(text).toContain("xoxb-");
  expect(text).toContain("xapp-");
  expect(text.toLowerCase()).toContain("signing secret");

  await expect(heading.first()).toBeVisible();
  await expect(nextHeading.first()).toBeVisible();
});

test("slack-integration page ships no runtime JS beyond the analytics tag", async ({
  page,
}) => {
  await page.goto("/docs/slack-integration");
  await expectNoRuntimeJsBeyondAnalytics(page, { allowPagefind: true });
});
