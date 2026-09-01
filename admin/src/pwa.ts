/**
 * admin/src/pwa.ts
 * Installable PWA shell for the admin console: manifest, service worker
 * body, and the icon metadata that both the icon-generation script and the
 * icon-serving route consume.
 *
 * Every function here is pure — no I/O, no Hono, no filesystem access —
 * so the caching contract (what gets precached, what a live fetch handler
 * is allowed to cache) is unit-testable without a real ServiceWorker or
 * browser environment. Route registration and static-file reads live in
 * admin-ui.ts, mirroring the metrics/src/api.ts STATIC_FILES pattern.
 *
 * CACHING IS DELIBERATELY AUSTERE: every byte behind /admin/ is
 * authenticated content. A cached HTML page or JSON response on a shared or
 * stolen phone is a data leak, so the precache list and the shouldCache
 * predicate are the security boundary here, not an afterthought.
 */

import { join } from "node:path";
// Locked design-token source — importing (not hardcoding) theme_color /
// background_color means token drift fails CI via the normal typecheck/test
// path rather than silently diverging from the rest of the brand system.
import tokens from "../../brand/tokens.json";

// ─── Paths ──────────────────────────────────────────────────────────────────

/** Default committed location for the six PWA icon PNGs. Injectable via AdminUIDeps.pwaAssetsDir for tests. */
export const PWA_ASSETS_DIR = join(import.meta.dir, "..", "pwa-assets");

// ─── Icon metadata ────────────────────────────────────────────────────────────

export interface PwaIconSpec {
  filename: string;
  size: number;
  purpose: "any" | "maskable" | "apple-touch-icon";
}

/**
 * The standard six-icon PWA set: 192/512 "any", 192/512 "maskable" (glyph
 * confined to the ~40% safe zone), a 180x180 apple-touch-icon (opaque
 * background — iOS composites transparent icons onto black), and a 32x32
 * favicon-sized icon for browser chrome / bookmarks.
 */
export const PWA_ICONS: readonly PwaIconSpec[] = [
  { filename: "icon-192.png", size: 192, purpose: "any" },
  { filename: "icon-512.png", size: 512, purpose: "any" },
  { filename: "icon-maskable-192.png", size: 192, purpose: "maskable" },
  { filename: "icon-maskable-512.png", size: 512, purpose: "maskable" },
  { filename: "apple-touch-icon.png", size: 180, purpose: "apple-touch-icon" },
  { filename: "favicon-32.png", size: 32, purpose: "any" },
];

// ─── Manifest ─────────────────────────────────────────────────────────────────

export interface WebAppManifest {
  name: string;
  short_name: string;
  scope: string;
  start_url: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
}

/**
 * Builds the web app manifest object. scope is /admin/ and start_url is
 * /admin/chat per the PWA shell spec — the manifest itself carries no
 * secrets and is served unauthenticated (browsers fetch it with
 * credentials:omit, so gating it behind a session would silently break
 * install).
 */
export function buildManifest(): WebAppManifest {
  return {
    name: "Shipwright Admin",
    short_name: "Shipwright",
    scope: "/admin/",
    start_url: "/admin/chat",
    display: "standalone",
    theme_color: tokens.color.brand.default,
    background_color: tokens.color.bg.base,
    icons: PWA_ICONS.filter((icon) => icon.purpose !== "apple-touch-icon").map(
      (icon) => ({
        src: `/admin/icons/${icon.filename}`,
        sizes: `${icon.size}x${icon.size}`,
        type: "image/png",
        purpose: icon.purpose,
      }),
    ),
  };
}

// ─── Precache allowlist ───────────────────────────────────────────────────────

const OFFLINE_PAGE_PATH = "/admin/offline.html";

/**
 * The EXACT set of URLs the service worker precaches: the offline fallback
 * page and the six icons. Nothing else — no document navigation, no JSON
 * route, nothing under /admin/chat/. Pure so it's independently
 * unit-testable against the allowlist (acceptance criterion 3).
 */
export function getPrecacheList(): string[] {
  return [
    OFFLINE_PAGE_PATH,
    ...PWA_ICONS.map((icon) => `/admin/icons/${icon.filename}`),
  ];
}

/**
 * Pure predicate deciding whether a given request is allowed to be cached
 * at all, independent of the precache list above — used by the service
 * worker's fetch handler (if it ever caches on-the-fly) as a second,
 * conservative gate. Only GET requests to a path already in the precache
 * list are cacheable; everything else (any HTML document navigation, any
 * .json route, anything under /admin/chat/, any non-GET) is refused.
 */
export function shouldCachePwaRequest(path: string, method: string): boolean {
  if (method.toUpperCase() !== "GET") return false;
  return getPrecacheList().includes(path);
}

// ─── Service worker body ─────────────────────────────────────────────────────

/**
 * Builds the service worker's JS source as a plain string — pure, no I/O.
 * The cache name embeds `version` so a version bump busts any previously
 * installed cache. Only precaches the given `precacheList` on install, and
 * only ever serves cached responses (or falls through to network) for GET
 * requests whose URL is in that exact list — this mirrors
 * shouldCachePwaRequest so the deployed SW's real behavior matches what's
 * unit-tested here.
 */
export function buildServiceWorkerBody(
  version: string,
  precacheList: string[],
): string {
  const cacheName = `shipwright-admin-pwa-v${version}`;
  const precacheJson = JSON.stringify(precacheList);

  return `// GENERATED by admin/src/pwa.ts's buildServiceWorkerBody — do not edit by hand.
// Caching is deliberately austere: every byte behind /admin/ is authenticated
// content, so only the offline fallback page and the app icons are ever
// cached. No HTML document navigation, no .json route, nothing under
// /admin/chat/, and no non-GET request is ever cached.
const CACHE_NAME = ${JSON.stringify(cacheName)};
const PRECACHE_URLS = ${precacheJson};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (!PRECACHE_URLS.includes(url.pathname)) return;

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request)),
  );
});

// Web Push (CFB-4.2). The payload is JSON {title, body, url}; the body is
// deliberately austere (see admin/src/push-content.ts) — it renders on a
// locked screen, so it never carries ids, repo names, paths, or costs.
self.addEventListener("push", (event) => {
  let payload = { title: "Your agent replied", body: "", url: "/admin/chat" };
  try {
    if (event.data) payload = Object.assign(payload, event.data.json());
  } catch {
    // Malformed payload — fall back to the generic default.
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body || undefined,
      data: { url: payload.url },
      tag: "shipwright-agent-reply",
    }),
  );
});

// Focus an existing tab on the target thread, or open one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target =
    (event.notification.data && event.notification.data.url) || "/admin/chat";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((wins) => {
        for (const win of wins) {
          if (win.url.indexOf(target) !== -1 && "focus" in win) {
            return win.focus();
          }
        }
        return self.clients.openWindow(target);
      }),
  );
});
`;
}

// ─── Offline fallback page ────────────────────────────────────────────────────

/**
 * Renders the precached offline fallback page — deliberately minimal and
 * self-contained (no admin-ui-layout.ts dependency, no live data): it's the
 * one document navigation the service worker is allowed to serve from cache
 * when the network is unavailable, so it must render correctly with zero
 * external requests.
 */
export function buildOfflinePageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Offline — Shipwright Admin</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: ${tokens.color.bg.base};
      color: ${tokens.color.text.body};
      font-family: system-ui, sans-serif;
      text-align: center;
      padding: 24px;
      box-sizing: border-box;
    }
    h1 { color: ${tokens.color.text.heading}; font-size: 1.5rem; margin-bottom: 8px; }
    p { color: ${tokens.color.text.editorial}; margin: 0; }
  </style>
</head>
<body>
  <div>
    <h1>You're offline</h1>
    <p>Reconnect to continue using Shipwright Admin.</p>
  </div>
</body>
</html>`;
}

// ─── Head tags (manifest link + SW registration) ──────────────────────────────

/**
 * Renders the <link rel="manifest"> tag and the SW-registration <script>,
 * gated on appBaseUrl being https — home-lab operators on plain HTTP would
 * otherwise see a broken/no-op install prompt and a SW registration that
 * silently fails (or, worse, throws in the console on every page load).
 * Returns "" when the gate fails, so callers can splice this directly into
 * <head> with no conditional of their own.
 */
export function renderPwaHeadTags(appBaseUrl: string): string {
  if (!appBaseUrl || !appBaseUrl.startsWith("https://")) return "";

  return [
    '<link rel="manifest" href="/admin/manifest.webmanifest" />',
    '<link rel="apple-touch-icon" href="/admin/icons/apple-touch-icon.png" />',
    `<meta name="theme-color" content="${tokens.color.brand.default}" />`,
    "<script>",
    "  if ('serviceWorker' in navigator) {",
    "    window.addEventListener('load', () => {",
    "      navigator.serviceWorker.register('/admin/sw.js');",
    "    });",
    "  }",
    "</script>",
  ].join("\n  ");
}
