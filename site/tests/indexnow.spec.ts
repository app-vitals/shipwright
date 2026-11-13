import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  buildIndexNowPayload,
  extractLocs,
  findIndexNowKey,
} from "../scripts/indexnow.mjs";

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
    "abcd1234",
    "https://shipwrightharness.com/abcd1234.txt",
    ["https://shipwrightharness.com/", "https://shipwrightharness.com/story/"],
  );
  expect(payload).toEqual({
    host: "shipwrightharness.com",
    key: "abcd1234",
    keyLocation: "https://shipwrightharness.com/abcd1234.txt",
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

// findIndexNowKey reads the key from public/ so the value lives in exactly one place
// (the published key file). Each case builds its own throwaway directory.
function withPublicDir(
  files: Record<string, string>,
  run: (dir: string) => void,
) {
  const dir = mkdtempSync(path.join(tmpdir(), "indexnow-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), body);
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("findIndexNowKey returns the key whose file name matches its content", () => {
  withPublicDir(
    { "abcd1234.txt": "abcd1234\n", "robots.txt": "User-agent: *\n" },
    (dir) => {
      expect(findIndexNowKey(dir)).toBe("abcd1234");
    },
  );
});

test("findIndexNowKey ignores .txt files whose content does not match the name", () => {
  withPublicDir({ "abcd1234.txt": "something-else" }, (dir) => {
    expect(findIndexNowKey(dir)).toBeNull();
  });
});

test("findIndexNowKey returns null when several key files are present", () => {
  withPublicDir(
    { "abcd1234.txt": "abcd1234", "wxyz5678.txt": "wxyz5678" },
    (dir) => {
      expect(findIndexNowKey(dir)).toBeNull();
    },
  );
});

test("findIndexNowKey returns null for an empty or missing directory", () => {
  withPublicDir({}, (dir) => {
    expect(findIndexNowKey(dir)).toBeNull();
    expect(findIndexNowKey(path.join(dir, "does-not-exist"))).toBeNull();
  });
});

test("findIndexNowKey skips a directory named like a key file", () => {
  withPublicDir({}, (dir) => {
    mkdirSync(path.join(dir, "abcd1234.txt"));
    expect(findIndexNowKey(dir)).toBeNull();
  });
});

test("site/public publishes exactly one valid IndexNow key file", () => {
  const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
  expect(findIndexNowKey(publicDir)).toMatch(/^[A-Za-z0-9-]{8,128}$/);
});
