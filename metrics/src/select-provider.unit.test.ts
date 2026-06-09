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
        POSTHOG_PERSONAL_API_KEY: "phk",
        POSTHOG_PROJECT_ID: "123",
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
});
