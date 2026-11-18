/**
 * metrics/src/lib/system-cron-buckets.unit.test.ts
 * Unit (SCM-8.3): one test per bucket rule + the 24h boundary. Buckets are
 * derived from task status and PR state only.
 */

import { describe, expect, test } from "bun:test";
import {
  classifyCronTask,
  IN_FLIGHT_MAX_AGE_MS,
  slotOf,
} from "./system-cron-buckets.ts";

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const task = (over: Record<string, unknown> = {}) => ({
  id: "SC-x-20261118T000000Z-o-r",
  status: "pending",
  repo: "o/r",
  pr: null,
  ...over,
});

describe("classifyCronTask", () => {
  test("shipped: PR merged", () => {
    expect(
      classifyCronTask(
        task({ status: "pr_open", pr: 1 }),
        { state: "merged", createdAt: ago(HOUR) },
        NOW,
      ),
    ).toBe("shipped");
  });

  test.each(["merged", "deployed", "released"])(
    "shipped: task status %s (no PR record needed)",
    (status) => {
      expect(classifyCronTask(task({ status }), undefined, NOW)).toBe(
        "shipped",
      );
    },
  );

  test("shipped beats blocked/cancelled when the PR merged", () => {
    expect(
      classifyCronTask(
        task({ status: "blocked", pr: 1 }),
        { state: "merged", createdAt: ago(HOUR) },
        NOW,
      ),
    ).toBe("shipped");
  });

  test("inFlight: PR open for less than 24h", () => {
    expect(
      classifyCronTask(
        task({ status: "pr_open", pr: 1 }),
        { state: "open", createdAt: ago(23 * HOUR) },
        NOW,
      ),
    ).toBe("inFlight");
  });

  test("24h boundary: exactly 24h open is stuck, 1ms younger is in flight", () => {
    const pr = (ageMs: number) => ({
      state: "open",
      createdAt: ago(ageMs),
    });
    const t = task({ status: "pr_open", pr: 1 });
    expect(classifyCronTask(t, pr(IN_FLIGHT_MAX_AGE_MS - 1), NOW)).toBe(
      "inFlight",
    );
    expect(classifyCronTask(t, pr(IN_FLIGHT_MAX_AGE_MS), NOW)).toBe("stuck");
    expect(classifyCronTask(t, pr(IN_FLIGHT_MAX_AGE_MS + 1), NOW)).toBe(
      "stuck",
    );
  });

  test("stuck: PR open longer than 24h", () => {
    expect(
      classifyCronTask(
        task({ status: "pr_open", pr: 1 }),
        { state: "open", createdAt: ago(48 * HOUR) },
        NOW,
      ),
    ).toBe("stuck");
  });

  test("stuck: task blocked, even with a young open PR", () => {
    expect(classifyCronTask(task({ status: "blocked" }), undefined, NOW)).toBe(
      "stuck",
    );
    expect(
      classifyCronTask(
        task({ status: "blocked", pr: 1 }),
        { state: "open", createdAt: ago(HOUR) },
        NOW,
      ),
    ).toBe("stuck");
  });

  test("failed: task cancelled", () => {
    expect(
      classifyCronTask(task({ status: "cancelled" }), undefined, NOW),
    ).toBe("failed");
  });

  test("noOp: task done with no PR", () => {
    expect(classifyCronTask(task({ status: "done" }), undefined, NOW)).toBe(
      "noOp",
    );
  });

  test("done with an unmerged PR is not a no-op (falls to pending)", () => {
    expect(
      classifyCronTask(
        task({ status: "done", pr: 3 }),
        { state: "closed", createdAt: ago(HOUR) },
        NOW,
      ),
    ).toBe("pending");
  });

  test.each(["pending", "in_progress"])("pending: task status %s", (status) => {
    expect(classifyCronTask(task({ status }), undefined, NOW)).toBe("pending");
  });

  test("pr_open task whose PR record is missing uses prCreatedAt as the age", () => {
    const t = (h: number) =>
      task({ status: "pr_open", pr: 9, prCreatedAt: ago(h * HOUR) });
    expect(classifyCronTask(t(2), undefined, NOW)).toBe("inFlight");
    expect(classifyCronTask(t(30), undefined, NOW)).toBe("stuck");
  });

  test("pr_open task with no PR record and no timestamp stays pending", () => {
    expect(
      classifyCronTask(task({ status: "pr_open", pr: 9 }), undefined, NOW),
    ).toBe("pending");
  });
});

describe("slotOf", () => {
  test("extracts the slot of an SC- task id", () => {
    expect(
      slotOf(
        "SC-docs-freshness-20261118T070000Z-app-vitals-x",
        "docs-freshness",
      ),
    ).toBe("20261118T070000Z");
  });
  test("a cron id that prefixes another does not claim its tasks' slots", () => {
    expect(slotOf("SC-docs-freshness-20261118T070000Z-o-r", "docs")).toBeNull();
  });
  test("non-SC ids return null", () => {
    expect(slotOf("FOO-1.1", "docs")).toBeNull();
  });
});
