/**
 * admin/src/account-agent-create.unit.test.ts
 * Unit tests for self-serve agent type resolution (AEP-1.2).
 */

import { describe, expect, it } from "bun:test";
import { getSelfServeAgentType } from "./account-agent-create.ts";

describe("getSelfServeAgentType", () => {
  it("defaults to coding", () => {
    expect(getSelfServeAgentType({})).toBe("coding");
  });

  it("honours SHIPWRIGHT_SELF_SERVE_AGENT_TYPE", () => {
    expect(
      getSelfServeAgentType({ SHIPWRIGHT_SELF_SERVE_AGENT_TYPE: "base" }),
    ).toBe("base");
  });
});
