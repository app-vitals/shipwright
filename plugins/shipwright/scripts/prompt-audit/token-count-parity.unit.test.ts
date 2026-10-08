/**
 * plugins/shipwright/scripts/prompt-audit/token-count-parity.unit.test.ts
 *
 * Pins the plugin-local CONTEXT_WINDOW map to lib/pricing's source of truth.
 */

import { describe, expect, test } from "bun:test";
import { CONTEXT_WINDOW as PRICING_WINDOW } from "../../../../lib/pricing.ts";
import { CONTEXT_WINDOW as LOCAL_WINDOW } from "./token-count.ts";

describe("CONTEXT_WINDOW parity", () => {
  test("plugin-local map equals lib/pricing CONTEXT_WINDOW", () => {
    expect(LOCAL_WINDOW).toEqual(PRICING_WINDOW);
  });
});
