import { expect, test } from "@playwright/test";
import { buildIndexNowPayload, extractLocs } from "../scripts/indexnow.mjs";

// Unit-level coverage for the pure logic in scripts/indexnow.mjs (the IndexNow
// post-deploy ping). No browser/page fixture needed — these are plain functions.

test("extractLocs pulls <loc> text out of a sitemap index", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://shipwrightharness.com/sitemap-0.xml</loc></sitemap>
</sitemapindex>`;
  expect(extractLocs(xml)).toEqual([
    "https://shipwrightharness.com/sitemap-0.xml",
  ]);
});

test("extractLocs pulls <loc> text out of a urlset, trimming whitespace", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://shipwrightharness.com/</loc></url>
  <url><loc>https://shipwrightharness.com/docs/introduction/</loc></url>
  <url><loc> https://shipwrightharness.com/compare/ </loc></url>
</urlset>`;
  expect(extractLocs(xml)).toEqual([
    "https://shipwrightharness.com/",
    "https://shipwrightharness.com/docs/introduction/",
    "https://shipwrightharness.com/compare/",
  ]);
});

test("extractLocs returns [] for empty, malformed, or missing input", () => {
  expect(extractLocs("")).toEqual([]);
  expect(extractLocs("<urlset></urlset>")).toEqual([]);
  expect(extractLocs(undefined)).toEqual([]);
  expect(extractLocs(null)).toEqual([]);
});

test("buildIndexNowPayload shapes the IndexNow API request body", () => {
  const payload = buildIndexNowPayload(
    "shipwrightharness.com",
    "0d3d07f9b20a1b45e3065369a72beeef",
    "https://shipwrightharness.com/0d3d07f9b20a1b45e3065369a72beeef.txt",
    ["https://shipwrightharness.com/", "https://shipwrightharness.com/story/"],
  );
  expect(payload).toEqual({
    host: "shipwrightharness.com",
    key: "0d3d07f9b20a1b45e3065369a72beeef",
    keyLocation:
      "https://shipwrightharness.com/0d3d07f9b20a1b45e3065369a72beeef.txt",
    urlList: [
      "https://shipwrightharness.com/",
      "https://shipwrightharness.com/story/",
    ],
  });
});

test("buildIndexNowPayload passes the urlList through unmodified (no implicit capping)", () => {
  const urls = Array.from(
    { length: 5 },
    (_, i) => `https://shipwrightharness.com/page-${i}/`,
  );
  const payload = buildIndexNowPayload("h", "k", "https://h/k.txt", urls);
  expect(payload.urlList).toHaveLength(5);
  expect(payload.urlList).toEqual(urls);
});
