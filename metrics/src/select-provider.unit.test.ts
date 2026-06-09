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
        POSTHOG_PERSONAL_API_KEY: "phk",
        POSTHOG_PROJECT_ID: "123",
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

  test("PostHog read-keys present → posthog", () => {
    expect(
      selectProviderMode({
        POSTHOG_PERSONAL_API_KEY: "phk",
        POSTHOG_PROJECT_ID: "123",
      }),
    ).toBe("posthog");
  });

  test("PostHog keys + postgres URL → posthog (posthog wins)", () => {
    expect(
      selectProviderMode({
        POSTHOG_PERSONAL_API_KEY: "phk",
        POSTHOG_PROJECT_ID: "123",
        METRICS_DATABASE_URL: "postgres://localhost/metrics",
      }),
    ).toBe("posthog");
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

  test("only one PostHog key present → sqlite (both required)", () => {
    expect(selectProviderMode({ POSTHOG_PERSONAL_API_KEY: "phk" })).toBe(
      "sqlite",
    );
    expect(selectProviderMode({ POSTHOG_PROJECT_ID: "123" })).toBe("sqlite");
  });

  test("empty-string PostHog keys are treated as absent → sqlite", () => {
    expect(
      selectProviderMode({
        POSTHOG_PERSONAL_API_KEY: "",
        POSTHOG_PROJECT_ID: "",
      }),
    ).toBe("sqlite");
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
