import { describe, expect, test } from "bun:test";
import { callerLabel } from "./request-context.ts";

describe("callerLabel — defined caller", () => {
  test("formats an admin caller (scope '*')", () => {
    expect(callerLabel({ name: "bodhi", scope: "*" })).toBe("bodhi (*)");
  });

  test("formats a caller scoped to a clientId", () => {
    expect(callerLabel({ name: "sully", scope: "client-xyz" })).toBe(
      "sully (client-xyz)",
    );
  });

  test("formats a caller scoped to an agentId", () => {
    expect(callerLabel({ name: "agent-123", scope: "agent-456" })).toBe(
      "agent-123 (agent-456)",
    );
  });

  test("is stable across repeated calls with the same input", () => {
    const caller = { name: "bodhi", scope: "*" };
    expect(callerLabel(caller)).toBe(callerLabel(caller));
  });
});

describe("callerLabel — undefined caller", () => {
  test("returns a distinct, readable label for undefined", () => {
    const label = callerLabel(undefined);
    expect(label).toBe("anonymous");
  });

  test("returns the same label when called with no argument", () => {
    expect(callerLabel()).toBe("anonymous");
  });

  test("undefined label never collides with a defined caller's label", () => {
    const anonymousLabel = callerLabel(undefined);
    expect(callerLabel({ name: "anonymous", scope: "*" })).not.toBe(
      anonymousLabel,
    );
  });
});
