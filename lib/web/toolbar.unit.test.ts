/**
 * lib/web/toolbar.unit.test.ts
 * Pure unit tests for renderShipwrightToolbar().
 *
 * Strategy: call the render function directly, assert on returned HTML strings.
 * No I/O, no Hono, no HTTP — pure string → string.
 */

import { describe, expect, test } from "bun:test";
import { renderShipwrightToolbar } from "./toolbar.ts";

describe("renderShipwrightToolbar", () => {
  describe("authenticated mode (readOnly=false)", () => {
    const html = renderShipwrightToolbar({
      userName: "Alice",
      activePath: "/admin/agents",
      logoutAction: "/auth/logout",
    });

    test("contains hamburger button with class vos-hamburger", () => {
      expect(html).toContain("vos-hamburger");
    });

    test("hamburger button shows ☰ icon", () => {
      expect(html).toContain("☰");
    });

    test("contains nav links for authenticated mode", () => {
      expect(html).toContain("Agents");
      expect(html).toContain("Metrics");
    });

    // TBF-1.1: the navbar Tasks link must not hardcode a state filter — doing
    // so silently pre-filtered every navbar-driven visit to ready-only tasks
    // and (post-AXR-1.3) bounced the user off the default board view. The
    // link must land on bare /admin/tasks.
    test("Tasks link has no hardcoded ?state=ready filter", () => {
      expect(html).not.toContain("/admin/tasks?state=ready");
      expect(html).toContain('href="/admin/tasks" class="vos-nav-link');
    });

    test("does not render an /admin/provision link (removed dead nav shortcut)", () => {
      expect(html).not.toContain('href="/admin/provision"');
    });

    test("active link has active class", () => {
      expect(html).toContain('class="vos-nav-link active"');
    });

    test("checkbox input appears before nav element in DOM", () => {
      expect(html.indexOf("<input")).toBeLessThan(html.indexOf("<nav"));
    });

    test("hamburger label has aria-expanded attribute for screen reader feedback", () => {
      expect(html).toContain('aria-expanded="false"');
    });

    test("hamburger label has aria-controls pointing to nav content", () => {
      expect(html).toContain('aria-controls="vos-nav-content"');
    });

    test("nav content div has id for aria-controls target", () => {
      expect(html).toContain('id="vos-nav-content"');
    });

    test("includes JS shim to toggle aria-expanded on checkbox change", () => {
      expect(html).toContain("aria-expanded");
      expect(html).toContain("<script>");
      expect(html).toContain("change");
    });

    test("contains a Queue & Activity link pointing at /admin/queue-activity", () => {
      expect(html).toContain('href="/admin/queue-activity"');
      expect(html).toContain("Queue &amp; Activity");
    });
  });

  describe("active-tab highlighting: Agents vs Queue & Activity (AXR-3.3)", () => {
    function activeHref(html: string): string | undefined {
      const match = html.match(
        /<a href="([^"]+)" class="vos-nav-link active">/,
      );
      return match?.[1];
    }

    test("/admin/agents highlights the Agents tab, not Queue & Activity", () => {
      const html = renderShipwrightToolbar({
        userName: "Alice",
        activePath: "/admin/agents",
        logoutAction: "/auth/logout",
      });
      expect(activeHref(html)).toBe("/admin/agents");
      expect(html).toContain(
        '<a href="/admin/queue-activity" class="vos-nav-link">',
      );
    });

    test("/admin/agents/:id highlights the Agents tab, not Queue & Activity", () => {
      const html = renderShipwrightToolbar({
        userName: "Alice",
        activePath: "/admin/agents/agent-123",
        logoutAction: "/auth/logout",
      });
      expect(activeHref(html)).toBe("/admin/agents");
      expect(html).toContain(
        '<a href="/admin/queue-activity" class="vos-nav-link">',
      );
    });

    test("/admin/agents/:id/queue-activity highlights Queue & Activity, not Agents", () => {
      const html = renderShipwrightToolbar({
        userName: "Alice",
        activePath: "/admin/agents/agent-123/queue-activity",
        logoutAction: "/auth/logout",
      });
      expect(activeHref(html)).toBe("/admin/queue-activity");
      expect(html).toContain(
        '<a href="/admin/agents" class="vos-nav-link">',
      );
    });
  });

  describe("read-only mode (readOnly=true)", () => {
    const html = renderShipwrightToolbar({
      userName: "",
      activePath: "/dashboard",
      logoutAction: "",
      readOnly: true,
    });

    test("contains hamburger button with class vos-hamburger", () => {
      expect(html).toContain("vos-hamburger");
    });

    test("hamburger button shows ☰ icon", () => {
      expect(html).toContain("☰");
    });

    test("contains only read-only nav links", () => {
      expect(html).toContain("Metrics");
      expect(html).toContain("Tasks");
    });

    test("does not contain authenticated-only links", () => {
      expect(html).not.toContain("Agents");
      expect(html).not.toContain("Sign out");
    });

    test("checkbox input appears before nav element in DOM", () => {
      expect(html.indexOf("<input")).toBeLessThan(html.indexOf("<nav"));
    });

    test("hamburger label has aria-expanded attribute for screen reader feedback", () => {
      expect(html).toContain('aria-expanded="false"');
    });

    test("hamburger label has aria-controls pointing to nav content", () => {
      expect(html).toContain('aria-controls="vos-nav-content"');
    });

    test("nav content div has id for aria-controls target", () => {
      expect(html).toContain('id="vos-nav-content"');
    });

    test("includes JS shim to toggle aria-expanded on checkbox change", () => {
      expect(html).toContain("aria-expanded");
      expect(html).toContain("<script>");
      expect(html).toContain("change");
    });
  });
});
