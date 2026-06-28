/**
 * Unit tests for pure helpers in agent/src/slack.ts.
 *
 * hasSlackCredentials gates whether the agent boots its Slack Bolt App. Bolt's
 * Socket Mode throws "Must provide an App-Level Token" when constructed without
 * a non-empty appToken, so the agent must only call createSlackApp when both the
 * bot token and the app-level token are present. Absent creds → offline mode.
 */

import { describe, expect, test } from "bun:test";
import { dispatchMarkers, hasSlackCredentials } from "./slack.ts";

describe("hasSlackCredentials", () => {
  test("true when both bot and app tokens are non-empty", () => {
    expect(
      hasSlackCredentials({ botToken: "xoxb-1", appToken: "xapp-1" }),
    ).toBe(true);
  });

  test("false when app token is missing (the Socket Mode requirement)", () => {
    expect(hasSlackCredentials({ botToken: "xoxb-1", appToken: "" })).toBe(
      false,
    );
  });

  test("false when bot token is missing", () => {
    expect(hasSlackCredentials({ botToken: "", appToken: "xapp-1" })).toBe(
      false,
    );
  });

  test("false when both are empty (offline dev default)", () => {
    expect(hasSlackCredentials({ botToken: "", appToken: "" })).toBe(false);
  });

  test("treats whitespace-only tokens as absent", () => {
    expect(hasSlackCredentials({ botToken: "  ", appToken: "  " })).toBe(false);
  });
});

// ─── dispatchMarkers — plan marker ──────────────────────────────────────────
// Injects a plain-object Slack client double (no mock.module, no global
// override) and asserts the [plan:url] marker posts a "View plan" message to
// the bound channel/thread.

describe("dispatchMarkers — plan marker", () => {
  test("posts a View plan message to the bound channel/thread", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test double captures calls
    const calls: any[] = [];
    const client = {
      chat: {
        // biome-ignore lint/suspicious/noExplicitAny: test double
        postMessage: async (a: any) => {
          calls.push(a);
          return { ok: true };
        },
      },
    };

    await dispatchMarkers(
      [{ type: "plan", url: "https://example.com/p/abc" }],
      { client, channel: "C123", threadTs: "1700.1" },
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.channel).toBe("C123");
    expect(call.thread_ts).toBe("1700.1");
    expect(JSON.stringify(call.blocks)).toContain("https://example.com/p/abc");
    expect(call.text).toContain("https://example.com/p/abc");
  });
});
