/**
 * admin/src/admin-ui-styles.unit.test.ts
 *
 * Unit tests for the shared admin CSS string builder — no I/O, pure string
 * assertions. Real responsive *behavior* (computed styles at real viewports)
 * is covered by admin/e2e/*.e2e.ts; these tests only lock in the structural
 * invariants that the e2e suite can't cheaply assert per-change (breakpoint
 * constant interpolation, the .data-table .btn touch-target exception).
 */

import { describe, expect, test } from "bun:test";
import {
  BREAKPOINT_MOBILE_MAX,
  BREAKPOINT_TABLET_MAX,
  baseStyles,
} from "./admin-ui-styles.ts";

describe("baseStyles — CFB-3.1 responsive breakpoints", () => {
  test("BREAKPOINT_MOBILE_MAX and BREAKPOINT_TABLET_MAX are exported numeric constants", () => {
    expect(typeof BREAKPOINT_MOBILE_MAX).toBe("number");
    expect(typeof BREAKPOINT_TABLET_MAX).toBe("number");
    expect(BREAKPOINT_MOBILE_MAX).toBeLessThan(BREAKPOINT_TABLET_MAX);
  });

  test("mobile @media block is interpolated from BREAKPOINT_MOBILE_MAX, not a hardcoded literal", () => {
    const css = baseStyles();
    expect(css).toContain(`@media (max-width: ${BREAKPOINT_MOBILE_MAX}px)`);
  });

  test("a tablet band exists between BREAKPOINT_MOBILE_MAX and BREAKPOINT_TABLET_MAX", () => {
    const css = baseStyles();
    expect(css).toContain(
      `@media (min-width: ${BREAKPOINT_MOBILE_MAX + 1}px) and (max-width: ${BREAKPOINT_TABLET_MAX}px)`,
    );
  });

  test(".data-table .btn stays at its own explicit height, unaffected by the mobile-wide .btn min-height rule", () => {
    const css = baseStyles();
    // The un-scoped mobile-wide 44px override must exist...
    expect(css).toMatch(/\.btn\s*\{[^}]*min-height:\s*44px/);
    // ...and .data-table .btn must have an explicit, smaller override so it
    // isn't dragged up to 44px by cascade (both selectors are specificity
    // 0,2,0 vs 0,1,0 pairs; .data-table .btn must appear with its own value).
    expect(css).toMatch(/\.data-table \.btn\s*\{[^}]*min-height:\s*36px/);
  });

  test(".form-input has no unconditional 16px+ font-size outside the mobile @media block (base rule stays 14px, mobile-only override bumps it)", () => {
    const css = baseStyles();
    const formInputBase = css.match(/\.form-input\s*\{([^}]*)\}/);
    expect(formInputBase).not.toBeNull();
    expect(formInputBase?.[1]).toContain("font-size: 14px");
  });
});
