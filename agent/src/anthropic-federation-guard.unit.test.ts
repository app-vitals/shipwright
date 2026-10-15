/**
 * agent/src/anthropic-federation-guard.unit.test.ts
 *
 * Unit tests for the WIF-2.1 defense-in-depth filter: with
 * ANTHROPIC_FEDERATION_RULE_ID in the pod env, the three Anthropic credential
 * keys never reach process.env, whether via startup applyEnv or syncConfig.
 */

import { describe, expect, it } from "bun:test";
import {
  ANTHROPIC_CREDENTIAL_KEYS,
  applyEnvToProcess,
  filterAnthropicCredentials,
} from "./anthropic-federation-guard.ts";

const CREDS = {
  CLAUDE_CODE_OAUTH_TOKEN: "oat-secret",
  ANTHROPIC_API_KEY: "api-secret",
  ANTHROPIC_AUTH_TOKEN: "auth-secret",
};

function setup(federated: boolean, initial: Record<string, string> = {}) {
  const processEnv: Record<string, string | undefined> = {
    ...(federated ? { ANTHROPIC_FEDERATION_RULE_ID: "rule-1" } : {}),
    ...initial,
  };
  const logged = new Set<string>();
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  return { processEnv, logged, logs, log };
}

describe("filterAnthropicCredentials", () => {
  it("lists exactly the three blocked keys", () => {
    expect([...ANTHROPIC_CREDENTIAL_KEYS].sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
  });

  it("returns env unchanged when federation is not configured", () => {
    const s = setup(false);
    const env = { FOO: "bar", ...CREDS };
    expect(filterAnthropicCredentials(env, s)).toEqual(env);
    expect(s.logs).toEqual([]);
  });

  it("drops the three keys and keeps the rest when federated", () => {
    const s = setup(true);
    expect(filterAnthropicCredentials({ FOO: "bar", ...CREDS }, s)).toEqual({
      FOO: "bar",
    });
  });

  it("also drops empty-string values (they still outrank federation)", () => {
    const s = setup(true);
    expect(
      filterAnthropicCredentials({ ANTHROPIC_API_KEY: "", FOO: "x" }, s),
    ).toEqual({ FOO: "x" });
  });

  it("logs once per key, names only, never values", () => {
    const s = setup(true);
    filterAnthropicCredentials({ ...CREDS }, s);
    filterAnthropicCredentials({ ...CREDS }, s);
    expect(s.logs).toHaveLength(3);
    const all = s.logs.join("\n");
    for (const k of ANTHROPIC_CREDENTIAL_KEYS) expect(all).toContain(k);
    for (const v of Object.values(CREDS)) expect(all).not.toContain(v);
  });

  it("deletes the keys from process.env when federated", () => {
    const s = setup(true, { ...CREDS, FOO: "keep" });
    filterAnthropicCredentials({}, s);
    expect(s.processEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(s.processEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(s.processEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(s.processEnv.FOO).toBe("keep");
  });

  it("leaves process.env alone when federation is not configured", () => {
    const s = setup(false, { ANTHROPIC_API_KEY: "mine" });
    filterAnthropicCredentials({}, s);
    expect(s.processEnv.ANTHROPIC_API_KEY).toBe("mine");
  });
});

describe("applyEnvToProcess", () => {
  it("applies all keys when not federated", () => {
    const s = setup(false);
    applyEnvToProcess({ FOO: "bar", ...CREDS }, s);
    expect(s.processEnv).toMatchObject({ FOO: "bar", ...CREDS });
  });

  it("startup: never leaves the three keys in process.env when federated", () => {
    const s = setup(true, { ANTHROPIC_API_KEY: "from-pod" });
    applyEnvToProcess({ FOO: "bar", ...CREDS }, s);
    expect(s.processEnv.FOO).toBe("bar");
    for (const k of ANTHROPIC_CREDENTIAL_KEYS) {
      expect(s.processEnv[k]).toBeUndefined();
    }
  });

  it("config sync: a later bundle containing the keys is filtered too", () => {
    const s = setup(true);
    applyEnvToProcess({ FOO: "1" }, s);
    applyEnvToProcess({ FOO: "2", ANTHROPIC_AUTH_TOKEN: "late" }, s);
    expect(s.processEnv.FOO).toBe("2");
    expect(s.processEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
});
