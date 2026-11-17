import { expect, test } from "@playwright/test";
import { adminSessionToken, authenticate, requireEnv } from "./helpers.ts";

test("admin UI loads with no console errors", async ({ page, context }) => {
  const adminUrl = requireEnv("PREVIEW_ADMIN_URL");
  await authenticate(context, await adminSessionToken(adminUrl), [adminUrl]);

  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));

  const response = await page.goto("/admin/agents", {
    waitUntil: "networkidle",
  });
  expect(response?.status()).toBe(200);
  expect(page.url()).not.toContain("/admin/login");
  await expect(page.locator("h1").first()).toBeVisible();
  expect(errors).toEqual([]);
});
