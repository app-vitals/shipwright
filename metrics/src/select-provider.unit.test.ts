/**
 * metrics/src/select-provider.unit.test.ts
 * Unit tests for the pure mode selector that maps env → provider mode.
 */

import { describe, expect, test } from "bun:test";
import { resolvePostgresUrl, selectProviderMode } from "./select-provider.ts";

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

  test("METRICS_OFFLINE=true overrides postgres URL too", () => {
    expect(
      selectProviderMode({
        METRICS_OFFLINE: "true",
        METRICS_DATABASE_URL: "postgres://localhost/metrics",
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

  test("only METRICS_TASK_STORE_URL set (no admin url) → sqlite", () => {
    expect(
      selectProviderMode({
        METRICS_TASK_STORE_URL: "http://task-store:3002",
      }),
    ).toBe("sqlite");
  });

  test("only METRICS_ADMIN_URL set (no task store url) → sqlite", () => {
    expect(
      selectProviderMode({
        METRICS_ADMIN_URL: "http://admin:3001",
      }),
    ).toBe("sqlite");
  });

  test("taskstore urls + postgres url → taskstore (taskstore wins)", () => {
    expect(
      selectProviderMode({
        METRICS_TASK_STORE_URL: "http://task-store:3002",
        METRICS_ADMIN_URL: "http://admin:3001",
        METRICS_DATABASE_URL: "postgres://localhost/metrics",
      }),
    ).toBe("taskstore");
  });

  test("non-http METRICS_TASK_STORE_URL + http admin url → sqlite", () => {
    expect(
      selectProviderMode({
        METRICS_TASK_STORE_URL: "localhost:3000",
        METRICS_ADMIN_URL: "http://admin:3001",
      }),
    ).toBe("sqlite");
  });

  test("METRICS_DATABASE_URL starting with postgres → postgres", () => {
    expect(
      selectProviderMode({
        METRICS_DATABASE_URL: "postgres://user:pass@localhost:5432/metrics",
      }),
    ).toBe("postgres");
  });

  test("METRICS_DATABASE_URL postgresql:// prefix → postgres", () => {
    expect(
      selectProviderMode({
        METRICS_DATABASE_URL: "postgresql://user:pass@localhost:5432/metrics",
      }),
    ).toBe("postgres");
  });

  test("DATABASE_URL_METRICS alias → postgres", () => {
    expect(
      selectProviderMode({
        DATABASE_URL_METRICS: "postgres://localhost/metrics",
      }),
    ).toBe("postgres");
  });

  test("METRICS_DATABASE_URL takes precedence over DATABASE_URL_METRICS", () => {
    expect(
      selectProviderMode({
        METRICS_DATABASE_URL: "postgres://primary/metrics",
        DATABASE_URL_METRICS: "postgres://secondary/metrics",
      }),
    ).toBe("postgres");
  });

  test("empty-string METRICS_DATABASE_URL → sqlite (not postgres)", () => {
    expect(
      selectProviderMode({
        METRICS_DATABASE_URL: "",
      }),
    ).toBe("sqlite");
  });

  test("whitespace-only METRICS_DATABASE_URL → sqlite", () => {
    expect(
      selectProviderMode({
        METRICS_DATABASE_URL: "   ",
      }),
    ).toBe("sqlite");
  });

  test("no env → sqlite (default)", () => {
    expect(selectProviderMode({})).toBe("sqlite");
  });

  test("METRICS_OFFLINE other than 'true' is ignored", () => {
    expect(selectProviderMode({ METRICS_OFFLINE: "1" })).toBe("sqlite");
    expect(selectProviderMode({ METRICS_OFFLINE: "false" })).toBe("sqlite");
  });

  test("non-postgres DATABASE_URL → sqlite", () => {
    expect(
      selectProviderMode({ METRICS_DATABASE_URL: "mysql://localhost/db" }),
    ).toBe("sqlite");
    expect(
      selectProviderMode({ METRICS_DATABASE_URL: "sqlite://./dev.db" }),
    ).toBe("sqlite");
  });
});

describe("resolvePostgresUrl", () => {
  test("returns METRICS_DATABASE_URL when set", () => {
    expect(
      resolvePostgresUrl({
        METRICS_DATABASE_URL: "postgres://localhost/metrics",
      }),
    ).toBe("postgres://localhost/metrics");
  });

  test("returns DATABASE_URL_METRICS as fallback", () => {
    expect(
      resolvePostgresUrl({
        DATABASE_URL_METRICS: "postgres://localhost/metrics",
      }),
    ).toBe("postgres://localhost/metrics");
  });

  test("METRICS_DATABASE_URL wins over DATABASE_URL_METRICS", () => {
    expect(
      resolvePostgresUrl({
        METRICS_DATABASE_URL: "postgres://primary/metrics",
        DATABASE_URL_METRICS: "postgres://secondary/metrics",
      }),
    ).toBe("postgres://primary/metrics");
  });

  test("returns undefined when neither is set", () => {
    expect(resolvePostgresUrl({})).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(resolvePostgresUrl({ METRICS_DATABASE_URL: "" })).toBeUndefined();
  });
});
