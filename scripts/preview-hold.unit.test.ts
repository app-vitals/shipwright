/**
 * scripts/preview-hold.unit.test.ts
 *
 * Pins the end conditions, window capping and comment content of the preview
 * hold loop with an injected clock and PR-state fetcher: no GitHub, no tunnel.
 */

import { describe, expect, it } from "bun:test";
import {
  buildComment,
  COMMENT_MARKER,
  computeWindowEnd,
  decideHold,
  type HoldState,
  JOB_BUDGET_MINUTES,
  MAX_POLL_FAILURES,
  type PrState,
  pidAlive,
  runHold,
} from "./preview-hold.ts";

const MIN = 60_000;
const T0 = 1_700_000_000_000;
const SHA = "abcdef1234567890";
const GOOD_PR: PrState = { open: true, labels: ["preview"], headSha: SHA };

const state = (over: Partial<HoldState> = {}): HoldState => ({
  jobStartMs: T0,
  windowEndMs: T0 + 120 * MIN,
  previewedSha: SHA,
  consecutiveFailures: 0,
  ...over,
});

describe("decideHold", () => {
  it("continues when everything is healthy", () => {
    const d = decideHold(state(), {
      nowMs: T0 + 10 * MIN,
      pr: GOOD_PR,
      tunnelAlive: true,
    });
    expect(d.stop).toBeNull();
  });

  const cases: [string, Parameters<typeof decideHold>, string][] = [
    [
      "window_elapsed",
      [state(), { nowMs: T0 + 120 * MIN, pr: GOOD_PR, tunnelAlive: true }],
      "window_elapsed",
    ],
    [
      "job_budget",
      [
        state({ windowEndMs: T0 + 999 * MIN }),
        {
          nowMs: T0 + JOB_BUDGET_MINUTES * MIN,
          pr: GOOD_PR,
          tunnelAlive: true,
        },
      ],
      "job_budget",
    ],
    [
      "label_removed",
      [
        state(),
        {
          nowMs: T0 + MIN,
          pr: { ...GOOD_PR, labels: [] },
          tunnelAlive: true,
        },
      ],
      "label_removed",
    ],
    [
      "pr_closed",
      [
        state(),
        {
          nowMs: T0 + MIN,
          pr: { ...GOOD_PR, open: false },
          tunnelAlive: true,
        },
      ],
      "pr_closed",
    ],
    [
      "head_changed",
      [
        state(),
        {
          nowMs: T0 + MIN,
          pr: { ...GOOD_PR, headSha: "ffff" },
          tunnelAlive: true,
        },
      ],
      "head_changed",
    ],
    [
      "tunnel_dead",
      [state(), { nowMs: T0 + MIN, pr: GOOD_PR, tunnelAlive: false }],
      "tunnel_dead",
    ],
    [
      "poll_failures",
      [
        state({ consecutiveFailures: MAX_POLL_FAILURES - 1 }),
        { nowMs: T0 + MIN, pr: null, tunnelAlive: true },
      ],
      "poll_failures",
    ],
  ];
  for (const [name, args, reason] of cases) {
    it(`returns ${name}`, () => {
      expect(decideHold(...args).stop).toBe(reason as never);
    });
  }

  it("continues on the first two failed polls and stops on the third", () => {
    let s = state();
    const obs = { nowMs: T0 + MIN, pr: null, tunnelAlive: true };
    for (let i = 0; i < 2; i++) {
      const d = decideHold(s, obs);
      expect(d.stop).toBeNull();
      s = { ...s, consecutiveFailures: d.consecutiveFailures };
    }
    expect(decideHold(s, obs).stop).toBe("poll_failures");
  });

  it("resets the failure count after a good poll", () => {
    const d = decideHold(state({ consecutiveFailures: 2 }), {
      nowMs: T0 + MIN,
      pr: GOOD_PR,
      tunnelAlive: true,
    });
    expect(d.consecutiveFailures).toBe(0);
  });
});

describe("computeWindowEnd", () => {
  it("uses the full window early in the job", () => {
    expect(computeWindowEnd(T0, T0 + 10 * MIN, 120)).toBe(T0 + 130 * MIN);
  });

  it("defaults to 120 minutes", () => {
    expect(computeWindowEnd(T0, T0)).toBe(T0 + 120 * MIN);
  });

  it("shortens a 120-minute request late in the job to 345 minutes after job start", () => {
    expect(computeWindowEnd(T0, T0 + 300 * MIN, 120)).toBe(
      T0 + JOB_BUDGET_MINUTES * MIN,
    );
  });
});

describe("buildComment", () => {
  it("live comment has URL, username, short SHA, expiry; never a password", () => {
    const body = buildComment({
      status: "live",
      url: "https://x.trycloudflare.com",
      sha: SHA,
      expiresAtMs: T0,
    });
    expect(body).toContain(COMMENT_MARKER);
    // The link goes to the session-starting route, not the bare host, which
    // would land on a sign-in page with no provider to choose.
    expect(body).toContain(
      "- URL: https://x.trycloudflare.com/admin/dev-login\n",
    );
    expect(body).toContain("`preview`");
    expect(body).toContain("abcdef1");
    expect(body).not.toContain(SHA);
    expect(body).toContain(new Date(T0).toISOString());
    expect(body).toContain("Maintainers hold the password");
    expect(body.toLowerCase()).not.toMatch(/password:/);
  });

  it("expired comment has no URL and names the reason", () => {
    const body = buildComment({ status: "expired", reason: "pr_closed" });
    expect(body).toContain(COMMENT_MARKER);
    expect(body).not.toContain("http");
    expect(body).toContain("pull request was closed");
  });
});

describe("runHold", () => {
  it("polls each minute and returns the first stop reason", async () => {
    let now = T0;
    let polls = 0;
    const reason = await runHold(
      { jobStartMs: T0, windowEndMs: T0 + 120 * MIN, previewedSha: SHA },
      {
        now: () => now,
        fetchPr: async () => {
          polls++;
          if (polls < 3) return GOOD_PR;
          return { ...GOOD_PR, open: false };
        },
        tunnelAlive: () => true,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );
    expect(reason).toBe("pr_closed");
    expect(now).toBe(T0 + 2 * MIN);
  });

  it("treats a throwing fetcher as a failed poll and fails closed", async () => {
    let now = T0;
    const reason = await runHold(
      { jobStartMs: T0, windowEndMs: T0 + 120 * MIN, previewedSha: SHA },
      {
        now: () => now,
        fetchPr: async () => {
          throw new Error("503");
        },
        tunnelAlive: () => true,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );
    expect(reason).toBe("poll_failures");
    expect(now).toBe(T0 + 2 * MIN);
  });
});

describe("pidAlive", () => {
  it("is true for this process and false for an unused pid", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 + 12345)).toBe(false);
  });
});
