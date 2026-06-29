/**
 * metrics/src/lib/env.unit.test.ts
 * Unit tests for validateRequiredEnv — fail-fast on missing environment variables.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { validateRequiredEnv } from "./env.ts";

import { getPublicMode, getPublicRepo, validatePublicModeEnv } from "./env.ts";

describe("validateRequiredEnv", () => {
  const TEST_VAR_A = "METRICS_TEST_REQUIRED_VAR_A";
  const TEST_VAR_B = "METRICS_TEST_REQUIRED_VAR_B";

  beforeEach(() => {
    delete process.env[TEST_VAR_A];
    delete process.env[TEST_VAR_B];
  });

  afterEach(() => {
    delete process.env[TEST_VAR_A];
    delete process.env[TEST_VAR_B];
  });

  it("does nothing when all required vars are set", () => {
    process.env[TEST_VAR_A] = "value-a";
    process.env[TEST_VAR_B] = "value-b";
    expect(() => validateRequiredEnv([TEST_VAR_A, TEST_VAR_B])).not.toThrow();
  });

  it("does nothing when the required list is empty", () => {
    expect(() => validateRequiredEnv([])).not.toThrow();
  });

  it("throws when a single required var is missing", () => {
    expect(() => validateRequiredEnv([TEST_VAR_A])).toThrow();
  });

  it("error message includes the missing var name", () => {
    expect(() => validateRequiredEnv([TEST_VAR_A])).toThrow(TEST_VAR_A);
  });

  it("throws listing ALL missing vars, not just the first", () => {
    let message = "";
    try {
      validateRequiredEnv([TEST_VAR_A, TEST_VAR_B]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(TEST_VAR_A);
    expect(message).toContain(TEST_VAR_B);
  });

  it("does not throw when only some vars are missing if all provided are set", () => {
    process.env[TEST_VAR_A] = "set";
    expect(() => validateRequiredEnv([TEST_VAR_A])).not.toThrow();
  });

  it("throws when one of two vars is missing", () => {
    process.env[TEST_VAR_A] = "value-a";
    // TEST_VAR_B is not set
    let message = "";
    try {
      validateRequiredEnv([TEST_VAR_A, TEST_VAR_B]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(TEST_VAR_B);
    expect(message).not.toContain(TEST_VAR_A);
  });

  it("error message tells the operator what to do", () => {
    let message = "";
    try {
      validateRequiredEnv([TEST_VAR_A]);
    } catch (e) {
      message = (e as Error).message;
    }
    // Should mention setting env vars or .env file
    expect(message.toLowerCase()).toMatch(/env|environment/);
  });
});

describe("getPublicMode", () => {
  beforeEach(() => {
    process.env.SHIPWRIGHT_METRICS_PUBLIC_MODE = undefined;
  });

  afterEach(() => {
    process.env.SHIPWRIGHT_METRICS_PUBLIC_MODE = undefined;
  });

  it("returns false by default", () => {
    expect(getPublicMode()).toBe(false);
  });

  it("returns true when SHIPWRIGHT_METRICS_PUBLIC_MODE=true", () => {
    process.env.SHIPWRIGHT_METRICS_PUBLIC_MODE = "true";
    expect(getPublicMode()).toBe(true);
  });

  it("returns true when SHIPWRIGHT_METRICS_PUBLIC_MODE=1", () => {
    process.env.SHIPWRIGHT_METRICS_PUBLIC_MODE = "1";
    expect(getPublicMode()).toBe(true);
  });

  it("returns false for other values", () => {
    process.env.SHIPWRIGHT_METRICS_PUBLIC_MODE = "false";
    expect(getPublicMode()).toBe(false);
    process.env.SHIPWRIGHT_METRICS_PUBLIC_MODE = "0";
    expect(getPublicMode()).toBe(false);
    process.env.SHIPWRIGHT_METRICS_PUBLIC_MODE = "yes";
    expect(getPublicMode()).toBe(false);
  });
});

describe("getPublicRepo", () => {
  beforeEach(() => {
    process.env.SHIPWRIGHT_METRICS_PUBLIC_REPO = undefined;
  });

  afterEach(() => {
    process.env.SHIPWRIGHT_METRICS_PUBLIC_REPO = undefined;
  });

  it("returns undefined when unset", () => {
    expect(getPublicRepo()).toBeUndefined();
  });

  it("returns the value when set", () => {
    process.env.SHIPWRIGHT_METRICS_PUBLIC_REPO = "app-vitals/shipwright";
    expect(getPublicRepo()).toBe("app-vitals/shipwright");
  });
});

describe("validatePublicModeEnv", () => {
  beforeEach(() => {
    process.env.SHIPWRIGHT_METRICS_PUBLIC_MODE = undefined;
    process.env.SHIPWRIGHT_METRICS_PUBLIC_REPO = undefined;
  });

  afterEach(() => {
    process.env.SHIPWRIGHT_METRICS_PUBLIC_MODE = undefined;
    process.env.SHIPWRIGHT_METRICS_PUBLIC_REPO = undefined;
  });

  it("does nothing when PUBLIC_MODE is false", () => {
    expect(() => validatePublicModeEnv()).not.toThrow();
  });

  it("does nothing when PUBLIC_MODE=true and PUBLIC_REPO is set", () => {
    process.env.SHIPWRIGHT_METRICS_PUBLIC_MODE = "true";
    process.env.SHIPWRIGHT_METRICS_PUBLIC_REPO = "app-vitals/shipwright";
    expect(() => validatePublicModeEnv()).not.toThrow();
  });

  it("throws when PUBLIC_MODE=true but PUBLIC_REPO is missing", () => {
    process.env.SHIPWRIGHT_METRICS_PUBLIC_MODE = "true";
    expect(() => validatePublicModeEnv()).toThrow();
  });

  it("error message lists the missing var name", () => {
    process.env.SHIPWRIGHT_METRICS_PUBLIC_MODE = "true";
    let message = "";
    try {
      validatePublicModeEnv();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("SHIPWRIGHT_METRICS_PUBLIC_REPO");
  });
});
