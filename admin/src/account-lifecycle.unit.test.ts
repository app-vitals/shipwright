/**
 * admin/src/account-lifecycle.unit.test.ts
 * Pure helpers behind the account lockdown lifecycle (SSP-8.2): which status
 * transitions lock down / restore, the trial-lapsed comparison, and the
 * account-level warning window (reusing isDueForWarning). Also a static guard
 * that none of the account lifecycle modules ever reach for deleteAgentFully.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isAccountTrialWarningDue,
  isLockedStatus,
  isTrialLapsed,
  resolveLockdownAction,
} from "./account-lifecycle.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-08T12:00:00.000Z");
const days = (n: number) => new Date(NOW.getTime() + n * DAY);

describe("isLockedStatus", () => {
  it("suspended and trial_expired are locked; active is not", () => {
    expect(isLockedStatus("suspended")).toBe(true);
    expect(isLockedStatus("trial_expired")).toBe(true);
    expect(isLockedStatus("active")).toBe(false);
  });
});

describe("resolveLockdownAction", () => {
  it("active -> suspended / trial_expired locks down", () => {
    expect(resolveLockdownAction("active", "suspended")).toBe("lockdown");
    expect(resolveLockdownAction("active", "trial_expired")).toBe("lockdown");
  });

  it("locked -> active restores", () => {
    expect(resolveLockdownAction("suspended", "active")).toBe("restore");
    expect(resolveLockdownAction("trial_expired", "active")).toBe("restore");
  });

  it("locked -> other locked status re-applies the (idempotent) lockdown", () => {
    expect(resolveLockdownAction("trial_expired", "suspended")).toBe(
      "lockdown",
    );
  });

  it("no status change does nothing", () => {
    expect(resolveLockdownAction("active", "active")).toBe("none");
    expect(resolveLockdownAction("suspended", "suspended")).toBe("none");
  });
});

describe("isTrialLapsed", () => {
  it("null never lapses", () => {
    expect(isTrialLapsed(null, NOW)).toBe(false);
  });

  it("strictly-past lapses; now and future do not", () => {
    expect(isTrialLapsed(days(-1), NOW)).toBe(true);
    expect(isTrialLapsed(new Date(NOW.getTime() - 1), NOW)).toBe(true);
    expect(isTrialLapsed(NOW, NOW)).toBe(false);
    expect(isTrialLapsed(days(1), NOW)).toBe(false);
  });
});

describe("isAccountTrialWarningDue (window comparison)", () => {
  it("2 days away with a 3-day window is due", () => {
    expect(isAccountTrialWarningDue(days(2), null, NOW, 3)).toBe(true);
  });

  it("exactly at the window edge is due; just past it is not", () => {
    expect(isAccountTrialWarningDue(days(3), null, NOW, 3)).toBe(true);
    expect(
      isAccountTrialWarningDue(new Date(days(3).getTime() + 1), null, NOW, 3),
    ).toBe(false);
  });

  it("5 days away with a 3-day window is not due", () => {
    expect(isAccountTrialWarningDue(days(5), null, NOW, 3)).toBe(false);
  });

  it("already warned is never due", () => {
    expect(isAccountTrialWarningDue(days(2), days(-1), NOW, 3)).toBe(false);
  });

  it("no trial is never due", () => {
    expect(isAccountTrialWarningDue(null, null, NOW, 3)).toBe(false);
  });

  it("defaults to the 3-day window", () => {
    expect(isAccountTrialWarningDue(days(2), null, NOW)).toBe(true);
    expect(isAccountTrialWarningDue(days(4), null, NOW)).toBe(false);
  });
});

describe("no deprovisioning in account lifecycle flows", () => {
  it("none of the SSP-8.2 modules reference deleteAgentFully", () => {
    for (const file of [
      "account-lifecycle.ts",
      "account-trial-expiry-sweeper.ts",
      "account-trial-warning-sweeper.ts",
    ]) {
      const src = readFileSync(join(import.meta.dir, file), "utf8");
      expect(src).not.toContain("deleteAgentFully(");
    }
  });
});
