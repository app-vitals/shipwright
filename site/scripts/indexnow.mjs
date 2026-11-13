#!/usr/bin/env node
/**
 * Post-deploy: submit every sitemap URL to IndexNow (Bing, DuckDuckGo, Seznam, Yandex — Google
 * does not consume IndexNow) so new/changed pages are discovered without waiting for a recrawl.
 * The key file (public/<key>.txt) is served by the site, which is how IndexNow verifies ownership.
 * That file is the single source of truth for the key: this script discovers it from public/
 * rather than repeating the value, so the key is never duplicated in code.
 *
 * Unlike a same-job static-file deploy, GitHub Pages fronts gh-pages through a CDN that can lag a
 * few seconds behind the push, so this script polls the live key URL until it resolves before
 * pinging — pinging with a not-yet-live key location would just get the submission ignored.
 *
 * Framework-free and defensive: a network error, a missing/empty sitemap, or a key URL that never
 * comes up within the poll budget logs and exits 0 — indexing pings must never fail a deploy.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "shipwrightharness.com";
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const SITEMAP_INDEX_URL = `https://${HOST}/sitemap-index.xml`;
const ENDPOINT = "https://api.indexnow.org/indexnow";
const MAX_URLS = 10000; // IndexNow per-request cap

const KEY_POLL_ATTEMPTS = 10;
const KEY_POLL_DELAY_MS = 5000;

/**
 * Extract <loc> text content from sitemap XML — works for both a sitemap index
 * (<loc> = child sitemap URL) and a urlset (<loc> = page URL). Exported for the unit test.
 */
export function extractLocs(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

/**
 * Find the IndexNow key published in `publicDir`: the one `<key>.txt` file whose name is a valid
 * IndexNow key (8-128 chars of a-z, A-Z, 0-9, "-") and whose trimmed content equals that name.
 * Returns null — never throws — when the directory is unreadable or holds zero or several
 * candidates, so an ambiguous setup skips the ping instead of submitting the wrong key.
 */
export function findIndexNowKey(publicDir) {
  let names;
  try {
    names = readdirSync(publicDir);
  } catch (err) {
    console.error(`indexnow: cannot read ${publicDir}: ${err.message}`);
    return null;
  }
  const keys = [];
  for (const name of names) {
    const match = /^([A-Za-z0-9-]{8,128})\.txt$/.exec(name);
    if (!match) continue;
    try {
      const body = readFileSync(path.join(publicDir, name), "utf8").trim();
      if (body === match[1]) keys.push(match[1]);
    } catch {
      // Unreadable candidate (e.g. a directory named like a key file) — not a key.
    }
  }
  if (keys.length !== 1) {
    console.error(
      `indexnow: expected exactly one key file in ${publicDir}, found ${keys.length}.`,
    );
    return null;
  }
  return keys[0];
}

/** Build the IndexNow submission payload. Pure — exported for the unit test. */
export function buildIndexNowPayload(host, key, keyLocation, urlList) {
  return { host, key, keyLocation, urlList };
}

/** Sleep helper, isolated so it's the only thing a caller would need to stub. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `url` until it responds 200 with a body matching `expectedBody` (trimmed), or the attempt
 * budget is exhausted. Never throws — a failed poll just returns false and the caller skips the ping.
 */
async function waitUntilLive(
  url,
  expectedBody,
  { attempts = KEY_POLL_ATTEMPTS, delayMs = KEY_POLL_DELAY_MS } = {},
) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.text()).trim();
        if (body === expectedBody) return true;
        console.error(
          `indexnow: key URL ${url} live but body mismatch (attempt ${i}/${attempts})`,
        );
      } else {
        console.error(
          `indexnow: key URL ${url} -> HTTP ${res.status} (attempt ${i}/${attempts})`,
        );
      }
    } catch (err) {
      console.error(
        `indexnow: key URL ${url} unreachable (attempt ${i}/${attempts}): ${err.message}`,
      );
    }
    if (i < attempts) await sleep(delayMs);
  }
  return false;
}

/** Fetch a sitemap URL and extract its <loc> entries. Returns [] on any failure. */
async function fetchLocs(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`indexnow: GET ${url} -> HTTP ${res.status}; skipping.`);
      return [];
    }
    return extractLocs(await res.text());
  } catch (err) {
    console.error(`indexnow: GET ${url} failed: ${err.message}; skipping.`);
    return [];
  }
}

async function main() {
  const key = findIndexNowKey(PUBLIC_DIR);
  if (!key) {
    console.error("indexnow: no usable key file; skipping ping.");
    return;
  }
  const keyLocation = `https://${HOST}/${key}.txt`;

  const live = await waitUntilLive(keyLocation, key);
  if (!live) {
    console.error(
      `indexnow: key URL ${keyLocation} never came up after ${KEY_POLL_ATTEMPTS} attempts; skipping ping.`,
    );
    return;
  }

  const sitemapUrls = await fetchLocs(SITEMAP_INDEX_URL);
  if (sitemapUrls.length === 0) {
    console.error(
      `indexnow: no child sitemaps found in ${SITEMAP_INDEX_URL}; skipping.`,
    );
    return;
  }

  const pageUrls = (
    await Promise.all(sitemapUrls.map((u) => fetchLocs(u)))
  ).flat();
  const urlList = [...new Set(pageUrls)].slice(0, MAX_URLS);
  if (urlList.length === 0) {
    console.error("indexnow: sitemaps contained no page URLs; skipping.");
    return;
  }

  const payload = buildIndexNowPayload(HOST, key, keyLocation, urlList);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  // 200/202 = accepted. Anything else is logged but non-fatal.
  console.log(
    `indexnow: submitted ${urlList.length} URLs -> HTTP ${res.status}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(path.basename(process.argv[1]))
) {
  main().catch((err) => {
    console.error(`indexnow: failed (non-fatal): ${err.message}`);
  });
}
