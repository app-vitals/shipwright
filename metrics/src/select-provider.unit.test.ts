/**
 * metrics/src/select-provider.unit.test.ts
 * Unit tests for the pure mode selector that maps env → provider mode.
 */

import { describe, expect, test } from "bun:test";
import { selectProviderMode } from "./select-provider.ts";

describe("selectProviderMode", () => {
  test("METRICS_OFFLINE=true → fixtures (highest priority)", () => {
    expect(
      selectProviderMode({
        METRICS_OFFLINE: "true",
        METRICS_TASK_STORE_URL: "http://task-store:3002",
        METRICS_ADMIN_URL: "http://admin:3001",
      }),
    ).toBe("fixtures");
  });

  test("METRICS_OFFLINE=true overrides taskstore env too", () => {
    expect(
      selectProviderMode({
        METRICS_OFFLINE: "true",
        METRICS_TASK_STORE_URL: "http://task-store:3002",
      }),
    ).toBe("fixtures");
  });

  test("both taskstore urls (http) present → taskstore", () => {
    expect(
      selectProviderMode({
        METRICS_TASK_STORE_URL: "http://task-store:3002",
        METRICS_ADMIN_URL: "http://admin:3001",
      }),
    ).toBe("taskstore");
  });

  test("METRICS_OFFLINE=true + taskstore env present → fixtures (offline wins)", () => {
    expect(
      selectProviderMode({
        METRICS_OFFLINE: "true",
        METRICS_TASK_STORE_URL: "http://task-store:3002",
        METRICS_ADMIN_URL: "http://admin:3001",
      }),
    ).toBe("fixtures");
  });

  test("only METRICS_TASK_STORE_URL set (no admin url) → taskstore (server will error on missing URL)", () => {
    expect(
      selectProviderMode({
        METRICS_TASK_STORE_URL: "http://task-store:3002",
      }),
    ).toBe("taskstore");
  });

  test("only METRICS_ADMIN_URL set (no task store url) → taskstore (server will error on missing URL)", () => {
    expect(
      selectProviderMode({
        METRICS_ADMIN_URL: "http://admin:3001",
      }),
    ).toBe("taskstore");
  });

  test("non-http METRICS_TASK_STORE_URL + http admin url → taskstore (server will error)", () => {
    expect(
      selectProviderMode({
        METRICS_TASK_STORE_URL: "localhost:3000",
        METRICS_ADMIN_URL: "http://admin:3001",
      }),
    ).toBe("taskstore");
  });

  test("no env → taskstore (default; server will error on missing URLs)", () => {
    expect(selectProviderMode({})).toBe("taskstore");
  });

  test("METRICS_OFFLINE other than 'true' is ignored", () => {
    expect(selectProviderMode({ METRICS_OFFLINE: "1" })).toBe("taskstore");
    expect(selectProviderMode({ METRICS_OFFLINE: "false" })).toBe("taskstore");
  });
});
