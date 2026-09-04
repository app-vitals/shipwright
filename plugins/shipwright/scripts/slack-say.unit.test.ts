/**
 * plugins/shipwright/scripts/slack-say.unit.test.ts
 *
 * Unit tests for slack-say.ts
 *
 * Design: the script exports a `postSlackSay(deps, argv)` function that
 * accepts injected dependencies (fetch, env lookup, stdout/stderr writers).
 * Tests inject stub implementations — no real network calls, no
 * `global.fetch`/`global.*` overrides, no `mock.module()`, per the repo's
 * test isolation rule.
 *
 * Fixtures use placeholder Slack ids only (no real channel/token/thread ids).
 */

import { describe, expect, test } from "bun:test";
import { type Deps, postSlackSay } from "./slack-say.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FAKE_TOKEN = "xoxb-fake-token";
const FAKE_CHANNEL = "C123456";
const FAKE_THREAD = "1234567890.123456";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("slack-say", () => {
  test("stdout fallback: no SLACK_BOT_TOKEN → writes text to stdout, exits 0, never calls fetch", async () => {
    const stdoutChunks: string[] = [];
    const fetchCalls: unknown[] = [];
    const deps: Deps = {
      fetch: async (url, init) => {
        fetchCalls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
      env: (name) => (name === "SLACK_CHANNEL_ID" ? FAKE_CHANNEL : undefined),
      stdout: (chunk) => stdoutChunks.push(chunk),
      stderr: () => {
        throw new Error("stderr should not be called");
      },
    };

    const result = await postSlackSay(deps, ["hello world"]);

    expect(result.exit).toBe(0);
    expect(fetchCalls.length).toBe(0);
    expect(stdoutChunks.join("")).toContain("hello world");
  });

  test("stdout fallback: no channel resolved (flag or env) → writes text to stdout, exits 0, never calls fetch", async () => {
    const stdoutChunks: string[] = [];
    const fetchCalls: unknown[] = [];
    const deps: Deps = {
      fetch: async (url, init) => {
        fetchCalls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
      env: (name) => (name === "SLACK_BOT_TOKEN" ? FAKE_TOKEN : undefined),
      stdout: (chunk) => stdoutChunks.push(chunk),
      stderr: () => {
        throw new Error("stderr should not be called");
      },
    };

    const result = await postSlackSay(deps, ["progress update"]);

    expect(result.exit).toBe(0);
    expect(fetchCalls.length).toBe(0);
    expect(stdoutChunks.join("")).toContain("progress update");
  });

  test("stdout fallback: neither token nor channel resolved → writes text to stdout, exits 0", async () => {
    const stdoutChunks: string[] = [];
    const deps: Deps = {
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
      env: () => undefined,
      stdout: (chunk) => stdoutChunks.push(chunk),
      stderr: () => {
        throw new Error("stderr should not be called");
      },
    };

    const result = await postSlackSay(deps, ["no config at all"]);

    expect(result.exit).toBe(0);
    expect(stdoutChunks.join("")).toContain("no config at all");
  });

  test("env precedence: channel/thread resolved from env when no flags given; thread_ts included in body", async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const deps: Deps = {
      fetch: async (url, init) => {
        fetchCalls.push({ url, init: init as RequestInit });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
      env: (name) => {
        if (name === "SLACK_BOT_TOKEN") return FAKE_TOKEN;
        if (name === "SLACK_CHANNEL_ID") return FAKE_CHANNEL;
        if (name === "SLACK_THREAD_TS") return FAKE_THREAD;
        return undefined;
      },
      stdout: () => {
        throw new Error("stdout should not be called on success");
      },
      stderr: () => {
        throw new Error("stderr should not be called on success");
      },
    };

    const result = await postSlackSay(deps, ["build finished"]);

    expect(result.exit).toBe(0);
    expect(fetchCalls.length).toBe(1);
    const call = fetchCalls[0];
    expect(call.url).toBe("https://slack.com/api/chat.postMessage");
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${FAKE_TOKEN}`,
    );
    expect(JSON.parse(call.init.body as string)).toEqual({
      channel: FAKE_CHANNEL,
      text: "build finished",
      mrkdwn: true,
      unfurl_links: false,
      thread_ts: FAKE_THREAD,
    });
  });

  test("flag precedence: --channel and --thread flags override env values", async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const deps: Deps = {
      fetch: async (url, init) => {
        fetchCalls.push({ url, init: init as RequestInit });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
      env: (name) => {
        if (name === "SLACK_BOT_TOKEN") return FAKE_TOKEN;
        if (name === "SLACK_CHANNEL_ID") return "C999999";
        if (name === "SLACK_THREAD_TS") return "9999999999.999999";
        return undefined;
      },
      stdout: () => {
        throw new Error("stdout should not be called on success");
      },
      stderr: () => {
        throw new Error("stderr should not be called on success");
      },
    };

    const result = await postSlackSay(deps, [
      "--channel",
      FAKE_CHANNEL,
      "--thread",
      FAKE_THREAD,
      "flagged message",
    ]);

    expect(result.exit).toBe(0);
    expect(fetchCalls.length).toBe(1);
    const body = JSON.parse(fetchCalls[0].init.body as string);
    expect(body.channel).toBe(FAKE_CHANNEL);
    expect(body.thread_ts).toBe(FAKE_THREAD);
    expect(body.text).toBe("flagged message");
  });

  test("thread omission: thread_ts key absent from body when unresolved from flag or env", async () => {
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const deps: Deps = {
      fetch: async (url, init) => {
        fetchCalls.push({ url, init: init as RequestInit });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
      env: (name) => {
        if (name === "SLACK_BOT_TOKEN") return FAKE_TOKEN;
        if (name === "SLACK_CHANNEL_ID") return FAKE_CHANNEL;
        return undefined;
      },
      stdout: () => {
        throw new Error("stdout should not be called on success");
      },
      stderr: () => {
        throw new Error("stderr should not be called on success");
      },
    };

    const result = await postSlackSay(deps, ["no thread here"]);

    expect(result.exit).toBe(0);
    const body = JSON.parse(fetchCalls[0].init.body as string);
    expect(body).toEqual({
      channel: FAKE_CHANNEL,
      text: "no thread here",
      mrkdwn: true,
      unfurl_links: false,
    });
    expect("thread_ts" in body).toBe(false);
  });

  test("Slack ok:false → single stderr line containing Slack's error string, exit 0", async () => {
    const stderrChunks: string[] = [];
    const deps: Deps = {
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: false, error: "channel_not_found" }),
      }),
      env: (name) => {
        if (name === "SLACK_BOT_TOKEN") return FAKE_TOKEN;
        if (name === "SLACK_CHANNEL_ID") return FAKE_CHANNEL;
        return undefined;
      },
      stdout: () => {
        throw new Error("stdout should not be called");
      },
      stderr: (chunk) => stderrChunks.push(chunk),
    };

    const result = await postSlackSay(deps, ["oops"]);

    expect(result.exit).toBe(0);
    expect(stderrChunks.length).toBe(1);
    expect(stderrChunks[0]).toContain("channel_not_found");
    expect(stderrChunks[0].match(/\n/g)?.length).toBe(1);
  });

  test("Slack non-2xx response → single stderr line containing the Slack error string, exit 0", async () => {
    const stderrChunks: string[] = [];
    const deps: Deps = {
      fetch: async () => ({
        ok: false,
        status: 500,
        json: async () => ({ ok: false, error: "internal_error" }),
      }),
      env: (name) => {
        if (name === "SLACK_BOT_TOKEN") return FAKE_TOKEN;
        if (name === "SLACK_CHANNEL_ID") return FAKE_CHANNEL;
        return undefined;
      },
      stdout: () => {
        throw new Error("stdout should not be called");
      },
      stderr: (chunk) => stderrChunks.push(chunk),
    };

    const result = await postSlackSay(deps, ["oops again"]);

    expect(result.exit).toBe(0);
    expect(stderrChunks.length).toBe(1);
    expect(stderrChunks[0]).toContain("internal_error");
  });

  test("Slack non-2xx response with unparsable body → single stderr line, exit 0, never throws", async () => {
    const stderrChunks: string[] = [];
    const deps: Deps = {
      fetch: async () => ({
        ok: false,
        status: 503,
        json: async () => {
          throw new Error("not json");
        },
      }),
      env: (name) => {
        if (name === "SLACK_BOT_TOKEN") return FAKE_TOKEN;
        if (name === "SLACK_CHANNEL_ID") return FAKE_CHANNEL;
        return undefined;
      },
      stdout: () => {
        throw new Error("stdout should not be called");
      },
      stderr: (chunk) => stderrChunks.push(chunk),
    };

    const result = await postSlackSay(deps, ["service unavailable"]);

    expect(result.exit).toBe(0);
    expect(stderrChunks.length).toBe(1);
  });

  test("success: exits 0 silently — nothing written to stdout or stderr", async () => {
    let stdoutCalled = false;
    let stderrCalled = false;
    const deps: Deps = {
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      }),
      env: (name) => {
        if (name === "SLACK_BOT_TOKEN") return FAKE_TOKEN;
        if (name === "SLACK_CHANNEL_ID") return FAKE_CHANNEL;
        return undefined;
      },
      stdout: () => {
        stdoutCalled = true;
      },
      stderr: () => {
        stderrCalled = true;
      },
    };

    const result = await postSlackSay(deps, ["all good"]);

    expect(result.exit).toBe(0);
    expect(stdoutCalled).toBe(false);
    expect(stderrCalled).toBe(false);
  });

  test("fetch throwing (network error) is caught defensively — single stderr line, exit 0, never throws to caller", async () => {
    const stderrChunks: string[] = [];
    const deps: Deps = {
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      env: (name) => {
        if (name === "SLACK_BOT_TOKEN") return FAKE_TOKEN;
        if (name === "SLACK_CHANNEL_ID") return FAKE_CHANNEL;
        return undefined;
      },
      stdout: () => {
        throw new Error("stdout should not be called");
      },
      stderr: (chunk) => stderrChunks.push(chunk),
    };

    const result = await postSlackSay(deps, ["network down"]);

    expect(result.exit).toBe(0);
    expect(stderrChunks.length).toBe(1);
  });
});
