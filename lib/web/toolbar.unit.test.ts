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

    test("active link has active class", () => {
      expect(html).toContain('class="vos-nav-link active"');
    });

    test("checkbox input appears before nav element in DOM", () => {
      expect(html.indexOf("<input")).toBeLessThan(html.indexOf("<nav"));
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
  });
});
