/**
 * admin/src/trial-expiry-sweeper.unit.test.ts
 * Unit tests for the pure warning-window / dedup logic behind
 * TrialExpiryWarningSweeper (ATE-2.1). No I/O, no doubles — just the exported
 * pure functions.
 */

import { describe, expect, it } from "bun:test";
import {
  buildTrialExpiryWarningMessage,
  DEFAULT_TRIAL_EXPIRY_WARNING_DAYS,
  isDueForWarning,
  isPastWarningGrace,
} from "./trial-expiry-sweeper.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-25T12:00:00.000Z");

function daysFromNow(days: number): Date {
  return new Date(NOW.getTime() + days * DAY_MS);
}

describe("isDueForWarning", () => {
  it("is never due when trialExpiresAt is unset (ATE-1.1 agents)", () => {
    expect(isDueForWarning(null, null, NOW, 3)).toBe(false);
  });

  it("is due when trialExpiresAt falls inside the warning window and never warned", () => {
    expect(isDueForWarning(daysFromNow(2), null, NOW, 3)).toBe(true);
  });

  it("is not due when trialExpiresAt is further away than the warning window", () => {
    expect(isDueForWarning(daysFromNow(10), null, NOW, 3)).toBe(false);
  });

  it("is due exactly at the window boundary (<=)", () => {
    expect(isDueForWarning(daysFromNow(3), null, NOW, 3)).toBe(true);
  });

  it("is not due just past the window boundary", () => {
    expect(isDueForWarning(daysFromNow(3.01), null, NOW, 3)).toBe(false);
  });

  it("is due for a recently-expired trial that was never warned", () => {
    expect(isDueForWarning(daysFromNow(-1), null, NOW, 3)).toBe(true);
  });

  it("is still due exactly at the grace boundary behind expiry", () => {
    expect(isDueForWarning(daysFromNow(-3), null, NOW, 3)).toBe(true);
  });

  it("is not due for a trial that lapsed further back than the grace window", () => {
    // Without this bound the first tick after deploy would Slack-warn every
    // long-lapsed trial agent at once — trialExpiresAt is freely settable to
    // any past date via PATCH /agents/:id.
    expect(isDueForWarning(daysFromNow(-3.01), null, NOW, 3)).toBe(false);
    expect(isDueForWarning(daysFromNow(-180), null, NOW, 3)).toBe(false);
  });

  it("honours an explicit graceDays wider than the warning window", () => {
    expect(isDueForWarning(daysFromNow(-10), null, NOW, 3, 14)).toBe(true);
    expect(isDueForWarning(daysFromNow(-20), null, NOW, 3, 14)).toBe(false);
  });

  it("is never due once trialExpiryWarnedAt is set, no matter how close expiry is (dedup)", () => {
    expect(isDueForWarning(daysFromNow(1), NOW, NOW, 3)).toBe(false);
  });

  it("is never due once warned even if the trial later gets pushed back out and back in the window", () => {
    // Re-running the check after the alert has fired must never re-send for the
    // same agent — trialExpiryWarnedAt gates it regardless of the current gap
    // to trialExpiresAt (acceptance criterion 2).
    const warnedAt = daysFromNow(-1);
    expect(isDueForWarning(daysFromNow(2), warnedAt, NOW, 3)).toBe(false);
  });

  it("defaults the window to 3 days when not passed explicitly", () => {
    expect(isDueForWarning(daysFromNow(2), null, NOW)).toBe(true);
    expect(DEFAULT_TRIAL_EXPIRY_WARNING_DAYS).toBe(3);
  });

  it("defaults graceDays to the warning window (symmetric band)", () => {
    expect(isDueForWarning(daysFromNow(-2), null, NOW)).toBe(true);
    expect(isDueForWarning(daysFromNow(-4), null, NOW)).toBe(false);
  });
});

describe("isPastWarningGrace", () => {
  it("is false for a future expiry", () => {
    expect(isPastWarningGrace(daysFromNow(1), NOW, 3)).toBe(false);
  });

  it("is false inside the grace window and true beyond it", () => {
    expect(isPastWarningGrace(daysFromNow(-3), NOW, 3)).toBe(false);
    expect(isPastWarningGrace(daysFromNow(-3.01), NOW, 3)).toBe(true);
  });
});

describe("buildTrialExpiryWarningMessage", () => {
  it("names the agent and the actual expiry date", () => {
    const text = buildTrialExpiryWarningMessage(
      "acme-agent",
      new Date("2026-09-28T00:00:00.000Z"),
      NOW,
    );
    expect(text).toContain("acme-agent");
    expect(text).toContain("2026-09-28");
  });

  it("uses future tense for an expiry that has not happened yet", () => {
    const text = buildTrialExpiryWarningMessage(
      "acme-agent",
      daysFromNow(2),
      NOW,
    );
    expect(text).toContain("expires on");
    expect(text).not.toContain("expired on");
    expect(text).toContain("After that date");
  });

  it("uses past tense for a trial that already lapsed (grace-window alert)", () => {
    // The sweeper still fires for a trial that lapsed within the grace
    // window; "will be locked down after <date in the past>" would read as if
    // the deadline were still ahead.
    const text = buildTrialExpiryWarningMessage(
      "acme-agent",
      daysFromNow(-2),
      NOW,
    );
    expect(text).toContain("expired on");
    expect(text).not.toContain("expires on");
    expect(text).not.toContain("After that date");
    // Same lockdown consequence either way.
    expect(text).toContain("crons will be disabled");
  });

  it("describes lockdown (crons disabled + Slack blocked), never deprovisioning", () => {
    const text = buildTrialExpiryWarningMessage(
      "acme-agent",
      new Date("2026-09-28T00:00:00.000Z"),
      NOW,
    );
    // ATE-3.1 was corrected to lockdown-only (crons disabled, Slack blocked) —
    // it never deletes the agent. The warning text must not claim otherwise.
    expect(text.toLowerCase()).not.toContain("deprovision");
    expect(text.toLowerCase()).not.toContain("deleted");
  });
});
