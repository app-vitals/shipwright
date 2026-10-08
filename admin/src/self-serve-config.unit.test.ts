/**
 * admin/src/self-serve-config.unit.test.ts
 *
 * Unit tests for the self-serve env config parser. Pure logic over an
 * injected env object — no process.env reads, no I/O.
 */

import { describe, expect, it } from "bun:test";
import { parseSelfServeConfig } from "./self-serve-config.ts";

function parse(env: Record<string, string | undefined>) {
  const warnings: string[] = [];
  const config = parseSelfServeConfig(env, (m) => warnings.push(m));
  return { config, warnings };
}

describe("parseSelfServeConfig", () => {
  it("defaults to off, 0 agents, and the default contact when env is empty", () => {
    const { config, warnings } = parse({});
    expect(config).toEqual({
      enabled: false,
      defaultMaxAgents: 0,
      contactEmail: "dan@app-vitals.com",
    });
    expect(warnings).toEqual([]);
  });

  it("enables only on the exact value 'enabled'", () => {
    expect(
      parse({ SHIPWRIGHT_SELF_SERVE_ENABLED: "enabled" }).config.enabled,
    ).toBe(true);
    for (const v of ["true", "1", "ENABLED", "", "disabled"]) {
      expect(parse({ SHIPWRIGHT_SELF_SERVE_ENABLED: v }).config.enabled).toBe(
        false,
      );
    }
  });

  it("parses a valid DEFAULT_MAX_AGENTS without warning", () => {
    const { config, warnings } = parse({
      SHIPWRIGHT_SELF_SERVE_DEFAULT_MAX_AGENTS: "3",
    });
    expect(config.defaultMaxAgents).toBe(3);
    expect(warnings).toEqual([]);
  });

  it("accepts an explicit 0", () => {
    const { config, warnings } = parse({
      SHIPWRIGHT_SELF_SERVE_DEFAULT_MAX_AGENTS: "0",
    });
    expect(config.defaultMaxAgents).toBe(0);
    expect(warnings).toEqual([]);
  });

  it.each(["-1", "1.5", "abc", "1e3", "99999999999999999999"])(
    "falls back to 0 and warns for invalid DEFAULT_MAX_AGENTS %p",
    (value) => {
      const { config, warnings } = parse({
        SHIPWRIGHT_SELF_SERVE_DEFAULT_MAX_AGENTS: value,
      });
      expect(config.defaultMaxAgents).toBe(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("SHIPWRIGHT_SELF_SERVE_DEFAULT_MAX_AGENTS");
    },
  );

  it("uses a custom contact email, trimmed", () => {
    expect(
      parse({ SHIPWRIGHT_SELF_SERVE_CONTACT_EMAIL: " ops@example.com " }).config
        .contactEmail,
    ).toBe("ops@example.com");
  });

  it("falls back to the default contact when blank", () => {
    expect(
      parse({ SHIPWRIGHT_SELF_SERVE_CONTACT_EMAIL: "  " }).config.contactEmail,
    ).toBe("dan@app-vitals.com");
  });
});
