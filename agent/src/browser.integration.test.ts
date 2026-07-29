/**
 * agent/src/browser.integration.test.ts
 *
 * Integration test for launchBrowser() — a real I/O boundary (an actual
 * Chromium process launch) with no existing coverage, so this exercises the
 * real dependency rather than a double per docs/testing.md's integration
 * layer definition.
 *
 * Verifies the browser launches under the same --no-sandbox flags the
 * container's restricted securityContext requires (see agent/src/browser.ts)
 * and that a trivial page can be navigated and read back.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { launchBrowser } from "./browser.ts";

describe("launchBrowser", () => {
  let browser: Browser | undefined;

  afterEach(async () => {
    if (browser) {
      await browser.close();
      browser = undefined;
    }
  });

  test("launches successfully", async () => {
    browser = await launchBrowser();
    expect(browser.isConnected()).toBe(true);
  });

  test("navigates a data: URL and reads back page content", async () => {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto(
      "data:text/html,<title>shipwright-browser-test</title><h1>hello</h1>",
    );
    expect(await page.title()).toBe("shipwright-browser-test");
    expect(await page.content()).toContain("hello");
    await page.close();
  });

  test("navigates about:blank and reports a ready document", async () => {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto("about:blank");
    const readyState = await page.evaluate(() => document.readyState);
    expect(readyState).toBe("complete");
    await page.close();
  });
});
