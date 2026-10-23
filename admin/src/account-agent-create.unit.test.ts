/**
 * admin/src/account-agent-create.unit.test.ts
 * Unit tests for self-serve specialty resolution (AEP-1.2).
 */

import { describe, expect, it } from "bun:test";
import { getSelfServeSpecialty } from "./account-agent-create.ts";

describe("getSelfServeSpecialty", () => {
  it("defaults to coding", () => {
    expect(getSelfServeSpecialty({})).toBe("coding");
    expect(
      getSelfServeSpecialty({ SHIPWRIGHT_DEFAULT_AGENT_TYPE: "fixture" }),
    ).toBe("fixture");
    expect(
      getSelfServeSpecialty({
        SHIPWRIGHT_DEFAULT_AGENT_TYPE: "fixture",
        SHIPWRIGHT_SELF_SERVE_AGENT_TYPE: "other",
      }),
    ).toBe("other");
  });

  it("honours SHIPWRIGHT_SELF_SERVE_AGENT_TYPE", () => {
    expect(
      getSelfServeSpecialty({ SHIPWRIGHT_SELF_SERVE_AGENT_TYPE: "base" }),
    ).toBe("base");
  });
});
