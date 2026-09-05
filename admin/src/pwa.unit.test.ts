/**
 * admin/src/pwa.unit.test.ts
 * Unit tests for the PWA shell's pure functions: manifest building, service
 * worker body generation, the precache allowlist, and the shouldCache
 * predicate. No I/O — everything here takes plain inputs and returns data.
 */

import { describe, expect, it } from "bun:test";
import tokens from "../../brand/tokens.json";
import {
  PWA_ICONS,
  buildManifest,
  buildOfflinePageHtml,
  buildServiceWorkerBody,
  getPrecacheList,
  renderPwaHeadTags,
  sanitizeStartUrl,
  shouldCachePwaRequest,
} from "./pwa.ts";

describe("getPrecacheList", () => {
  it("is exactly the offline page plus the six icons — nothing else", () => {
    const list = getPrecacheList();
    const expected = [
      "/admin/offline.html",
      ...PWA_ICONS.map((icon) => `/admin/icons/${icon.filename}`),
    ];
    expect(list.sort()).toEqual(expected.sort());
    expect(list.length).toBe(7);
  });

  it("contains no HTML document routes other than the offline fallback", () => {
    const list = getPrecacheList();
    const nonOfflineHtml = list.filter(
      (url) => url.endsWith(".html") && url !== "/admin/offline.html",
    );
    expect(nonOfflineHtml).toEqual([]);
  });

  it("contains no .json routes", () => {
    const list = getPrecacheList();
    expect(list.some((url) => url.endsWith(".json"))).toBe(false);
  });

  it("contains nothing under /admin/chat/", () => {
    const list = getPrecacheList();
    expect(list.some((url) => url.startsWith("/admin/chat/"))).toBe(false);
  });
});

describe("shouldCachePwaRequest", () => {
  it("allows GET requests for precached icon paths", () => {
    expect(shouldCachePwaRequest("/admin/icons/icon-192.png", "GET")).toBe(
      true,
    );
  });

  it("allows GET for the offline fallback page", () => {
    expect(shouldCachePwaRequest("/admin/offline.html", "GET")).toBe(true);
  });

  it("never caches document navigations (other HTML paths)", () => {
    expect(shouldCachePwaRequest("/admin/agents", "GET")).toBe(false);
    expect(shouldCachePwaRequest("/admin/agents/abc123", "GET")).toBe(false);
    expect(shouldCachePwaRequest("/admin/login", "GET")).toBe(false);
  });

  it("never caches any .json route", () => {
    expect(shouldCachePwaRequest("/admin/manifest.webmanifest", "GET")).toBe(
      false,
    );
    expect(shouldCachePwaRequest("/agents/config.json", "GET")).toBe(false);
  });

  it("never caches anything under /admin/chat/", () => {
    expect(shouldCachePwaRequest("/admin/chat/", "GET")).toBe(false);
    expect(shouldCachePwaRequest("/admin/chat/thread-1", "GET")).toBe(false);
    expect(shouldCachePwaRequest("/admin/chat/thread-1/messages", "GET")).toBe(
      false,
    );
  });

  it("never caches non-GET requests, even for allowlisted paths", () => {
    expect(shouldCachePwaRequest("/admin/icons/icon-192.png", "POST")).toBe(
      false,
    );
    expect(shouldCachePwaRequest("/admin/offline.html", "PUT")).toBe(false);
    expect(shouldCachePwaRequest("/admin/offline.html", "DELETE")).toBe(false);
    expect(shouldCachePwaRequest("/admin/offline.html", "HEAD")).toBe(false);
  });

  it("never caches an arbitrary unknown path", () => {
    expect(shouldCachePwaRequest("/admin/some-random-thing", "GET")).toBe(
      false,
    );
  });
});

describe("PWA_ICONS", () => {
  it("declares exactly six icons", () => {
    expect(PWA_ICONS.length).toBe(6);
  });

  it("includes at least one maskable icon and the apple-touch-icon", () => {
    expect(PWA_ICONS.some((i) => i.purpose === "maskable")).toBe(true);
    expect(PWA_ICONS.some((i) => i.filename === "apple-touch-icon.png")).toBe(
      true,
    );
  });
});

describe("buildManifest", () => {
  it("sets scope /admin/, start_url /admin/chat, and display standalone", () => {
    const manifest = buildManifest();
    expect(manifest.scope).toBe("/admin/");
    expect(manifest.start_url).toBe("/admin/chat");
    expect(manifest.display).toBe("standalone");
  });

  it("sources theme_color and background_color from brand/tokens.json", () => {
    const manifest = buildManifest();
    expect(manifest.theme_color).toBe(tokens.color.brand.default);
    expect(manifest.background_color).toBe(tokens.color.bg.base);
  });

  it("declares icons entries with any + maskable purposes and correct src paths", () => {
    const manifest = buildManifest();
    expect(manifest.icons.length).toBe(
      PWA_ICONS.filter((i) => i.purpose !== "apple-touch-icon").length,
    );
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith("/admin/icons/")).toBe(true);
      expect(["any", "maskable"]).toContain(icon.purpose);
    }
  });

  it("uses a caller-supplied startUrl as start_url (PWA-1.1)", () => {
    const manifest = buildManifest("/admin/tasks");
    expect(manifest.start_url).toBe("/admin/tasks");
  });

  it("still defaults to /admin/chat when startUrl is omitted (backward compatible)", () => {
    const manifest = buildManifest(undefined);
    expect(manifest.start_url).toBe("/admin/chat");
  });
});

describe("sanitizeStartUrl (PWA-1.1)", () => {
  it("falls back to /admin/chat for null, undefined, and empty input", () => {
    expect(sanitizeStartUrl(null)).toBe("/admin/chat");
    expect(sanitizeStartUrl(undefined)).toBe("/admin/chat");
    expect(sanitizeStartUrl("")).toBe("/admin/chat");
  });

  it("passes through same-origin /admin/... paths unchanged", () => {
    expect(sanitizeStartUrl("/admin/chat")).toBe("/admin/chat");
    expect(sanitizeStartUrl("/admin/tasks")).toBe("/admin/tasks");
    expect(sanitizeStartUrl("/admin/agents/123")).toBe("/admin/agents/123");
  });

  it("rejects bare /admin with no trailing in-scope content", () => {
    expect(sanitizeStartUrl("/admin")).toBe("/admin/chat");
  });

  it("rejects external absolute URLs", () => {
    expect(sanitizeStartUrl("https://evil.com")).toBe("/admin/chat");
    expect(sanitizeStartUrl("http://evil.com/admin/chat")).toBe("/admin/chat");
  });

  it("rejects protocol-relative URLs", () => {
    expect(sanitizeStartUrl("//evil.com/x")).toBe("/admin/chat");
  });

  it("rejects javascript: URLs", () => {
    expect(sanitizeStartUrl("javascript:alert(1)")).toBe("/admin/chat");
  });

  it("rejects path traversal, raw and encoded", () => {
    expect(sanitizeStartUrl("/admin/../etc/passwd")).toBe("/admin/chat");
    expect(sanitizeStartUrl("/admin/tasks/../../etc/passwd")).toBe(
      "/admin/chat",
    );
    expect(sanitizeStartUrl("/admin/%2e%2e/etc/passwd")).toBe("/admin/chat");
  });

  it("rejects malformed percent-encoding instead of throwing", () => {
    expect(sanitizeStartUrl("/admin/%zz")).toBe("/admin/chat");
  });

  it("rejects a path not under /admin/", () => {
    expect(sanitizeStartUrl("/tasks")).toBe("/admin/chat");
    expect(sanitizeStartUrl("/")).toBe("/admin/chat");
  });

  it("rejects the PWA shell's own non-navigable asset routes", () => {
    expect(sanitizeStartUrl("/admin/manifest.webmanifest")).toBe("/admin/chat");
    expect(sanitizeStartUrl("/admin/sw.js")).toBe("/admin/chat");
    expect(sanitizeStartUrl("/admin/offline.html")).toBe("/admin/chat");
    expect(sanitizeStartUrl("/admin/icons/icon-192.png")).toBe("/admin/chat");
    expect(sanitizeStartUrl("/admin/icons/apple-touch-icon.png")).toBe(
      "/admin/chat",
    );
  });

  it("rejects the PWA shell's own auth routes", () => {
    expect(sanitizeStartUrl("/admin/login")).toBe("/admin/chat");
    expect(sanitizeStartUrl("/admin/logout")).toBe("/admin/chat");
  });

  it("rejects OAuth callback routes for every provider", () => {
    expect(sanitizeStartUrl("/admin/auth/callback")).toBe("/admin/chat");
    expect(sanitizeStartUrl("/admin/auth/okta/callback")).toBe("/admin/chat");
    expect(
      sanitizeStartUrl("/admin/agents/abc123/connect-slack/callback"),
    ).toBe("/admin/chat");
    expect(
      sanitizeStartUrl("/admin/agents/abc123/connect-github/callback"),
    ).toBe("/admin/chat");
  });
});

describe("buildServiceWorkerBody", () => {
  it("interpolates the version into the cache name", () => {
    const body = buildServiceWorkerBody("1.200.0", getPrecacheList());
    expect(body).toContain("shipwright-admin-pwa-v1.200.0");
  });

  it("embeds exactly the precache list, not an arbitrary superset", () => {
    const precache = getPrecacheList();
    const body = buildServiceWorkerBody("1.200.0", precache);
    for (const url of precache) {
      expect(body).toContain(JSON.stringify(url));
    }
  });

  it("is a pure function — repeated calls with the same input are identical", () => {
    const precache = getPrecacheList();
    const a = buildServiceWorkerBody("1.200.0", precache);
    const b = buildServiceWorkerBody("1.200.0", precache);
    expect(a).toBe(b);
  });

  it("different versions bust the cache name", () => {
    const precache = getPrecacheList();
    const a = buildServiceWorkerBody("1.200.0", precache);
    const b = buildServiceWorkerBody("1.201.0", precache);
    expect(a).not.toBe(b);
  });
});

describe("buildServiceWorkerBody — push + notificationclick (CFB-4.2)", () => {
  it("registers a push listener that shows a notification", () => {
    const body = buildServiceWorkerBody("1.200.0", getPrecacheList());
    expect(body).toContain('addEventListener("push"');
    expect(body).toContain("showNotification");
  });

  it("registers a notificationclick listener that focuses/opens the thread", () => {
    const body = buildServiceWorkerBody("1.200.0", getPrecacheList());
    expect(body).toContain('addEventListener("notificationclick"');
    expect(body).toContain("clients.openWindow");
  });

  it("reads the deep-link url from the notification payload data", () => {
    const body = buildServiceWorkerBody("1.200.0", getPrecacheList());
    // The push payload is JSON {title, body, url}; the SW must parse it.
    expect(body).toContain("event.data");
    expect(body).toContain(".url");
  });
});

describe("buildOfflinePageHtml", () => {
  it("renders a self-contained document with no external requests", () => {
    const html = buildOfflinePageHtml();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<img");
  });

  it("is a pure function — deterministic output", () => {
    expect(buildOfflinePageHtml()).toBe(buildOfflinePageHtml());
  });
});

describe("renderPwaHeadTags", () => {
  it("includes the manifest link and SW registration script for an https appBaseUrl", () => {
    const head = renderPwaHeadTags("https://admin.example.com");
    expect(head).toContain('rel="manifest"');
    expect(head).toContain("/admin/manifest.webmanifest");
    expect(head).toContain("serviceWorker");
    expect(head).toContain("/admin/sw.js");
  });

  it("is suppressed entirely for a plain-http appBaseUrl (home-lab operators)", () => {
    const head = renderPwaHeadTags("http://localhost:3001");
    expect(head).toBe("");
  });

  it("is suppressed for a malformed/empty appBaseUrl", () => {
    expect(renderPwaHeadTags("")).toBe("");
  });

  it("gives the manifest link a stable id and rewrites its href to the current pathname on load (PWA-1.1)", () => {
    const head = renderPwaHeadTags("https://admin.example.com");
    expect(head).toContain('id="pwa-manifest-link"');
    expect(head).toContain("getElementById('pwa-manifest-link')");
    expect(head).toContain("location.pathname");
    expect(head).toContain("?start=");
    expect(head).toContain("encodeURIComponent");
  });
});
