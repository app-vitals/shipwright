/**
 * metrics/src/lib/env.unit.test.ts
 * Unit tests for validateRequiredEnv — fail-fast on missing environment variables.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { validateRequiredEnv } from "./env.ts";

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
