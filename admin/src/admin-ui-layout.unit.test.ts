/**
 * admin/src/admin-ui-layout.unit.test.ts
 * Pure unit tests for renderAdminPage() — the shared admin page-head helper.
 *
 * Strategy: call renderAdminPage() directly, assert on the returned HTML
 * string. No I/O, no Hono, no HTTP — pure string → string.
 */

import { describe, expect, test } from "bun:test";
import { renderAdminPage } from "./admin-ui-layout.ts";

describe("renderAdminPage", () => {
  test("renders a full HTML document with DOCTYPE, head, and body", () => {
    const html = renderAdminPage({
      title: "My Page",
      body: "<div>hello</div>",
    });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("</html>");
    expect(html).toContain("<div>hello</div>");
  });

  test("escapes the title param", () => {
    const html = renderAdminPage({
      title: '<script>alert("xss")</script>',
      body: "<div>hello</div>",
    });
    expect(html).not.toContain("<title><script>");
    expect(html).toContain(
      "<title>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</title>",
    );
  });

  test("normalizes the viewport meta to width=device-width, initial-scale=1, viewport-fit=cover", () => {
    const html = renderAdminPage({ title: "Page", body: "<div></div>" });
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
    );
    expect(html).not.toContain("maximum-scale=1");
  });

  test("renders exactly one DOCTYPE and one viewport meta tag", () => {
    const html = renderAdminPage({ title: "Page", body: "<div></div>" });
    expect(html.match(/<!DOCTYPE html>/g)?.length).toBe(1);
    expect(html.match(/<meta name="viewport"/g)?.length).toBe(1);
  });

  test("includes charset meta tag", () => {
    const html = renderAdminPage({ title: "Page", body: "<div></div>" });
    expect(html).toContain('<meta charset="utf-8" />');
  });

  test("extraStyles content appears after baseStyles() inside the style tag", () => {
    const html = renderAdminPage({
      title: "Page",
      extraStyles: ".my-extra-class { color: red; }",
      body: "<div></div>",
    });
    const styleOpenIdx = html.indexOf("<style>");
    const styleCloseIdx = html.indexOf("</style>");
    const extraIdx = html.indexOf(".my-extra-class");
    expect(styleOpenIdx).toBeGreaterThan(-1);
    expect(extraIdx).toBeGreaterThan(styleOpenIdx);
    expect(extraIdx).toBeLessThan(styleCloseIdx);

    // baseStyles() output (e.g. the .page-header rule) must precede extraStyles.
    const baseStylesIdx = html.indexOf(".page-header");
    expect(baseStylesIdx).toBeGreaterThan(-1);
    expect(baseStylesIdx).toBeLessThan(extraIdx);
  });

  test("without extraStyles, style tag still closes cleanly right after baseStyles()", () => {
    const html = renderAdminPage({ title: "Page", body: "<div></div>" });
    expect(html).toContain("</style>");
  });

  test("headExtra content is included in the head, after the style tag", () => {
    const html = renderAdminPage({
      title: "Page",
      headExtra: '<link rel="manifest" href="/manifest.json" />',
      body: "<div></div>",
    });
    const styleCloseIdx = html.indexOf("</style>");
    const headExtraIdx = html.indexOf("/manifest.json");
    const headCloseIdx = html.indexOf("</head>");
    expect(headExtraIdx).toBeGreaterThan(styleCloseIdx);
    expect(headExtraIdx).toBeLessThan(headCloseIdx);
  });

  test("without headExtra, head still closes cleanly", () => {
    const html = renderAdminPage({ title: "Page", body: "<div></div>" });
    expect(html).toContain("</head>");
  });

  test("bodyClass is applied to the body tag when provided", () => {
    const html = renderAdminPage({
      title: "Page",
      bodyClass: "my-body-class",
      body: "<div></div>",
    });
    expect(html).toContain('<body class="my-body-class">');
  });

  test("body has no class attribute when bodyClass is omitted", () => {
    const html = renderAdminPage({ title: "Page", body: "<div></div>" });
    expect(html).toContain("<body>");
    expect(html).not.toContain("<body class=");
  });

  test("bodyEnd content appears after body content and before </body>", () => {
    const html = renderAdminPage({
      title: "Page",
      body: '<div id="main-body-marker">main</div>',
      bodyEnd: '<script id="body-end-marker">console.log("end")</script>',
    });
    const bodyIdx = html.indexOf("main-body-marker");
    const bodyEndIdx = html.indexOf("body-end-marker");
    const bodyCloseIdx = html.indexOf("</body>");
    expect(bodyIdx).toBeGreaterThan(-1);
    expect(bodyEndIdx).toBeGreaterThan(bodyIdx);
    expect(bodyEndIdx).toBeLessThan(bodyCloseIdx);
  });

  test("without bodyEnd, body closes cleanly right after body content", () => {
    const html = renderAdminPage({ title: "Page", body: "<div>content</div>" });
    expect(html).toContain("<div>content</div>");
    expect(html).toContain("</body>");
  });

  test("does not call renderAdminToolbar or inject any toolbar markup", () => {
    const html = renderAdminPage({ title: "Page", body: "<div></div>" });
    // baseStyles() legitimately contains `.vos-toolbar { ... }` and
    // `.vos-signout-btn { ... }` CSS rules, but renderAdminPage itself must
    // never inject the toolbar's actual <nav>/<button> markup — that's the
    // caller's responsibility via body.
    expect(html).not.toContain('<nav class="vos-toolbar"');
    expect(html).not.toContain('class="vos-signout-btn"');
  });
});
