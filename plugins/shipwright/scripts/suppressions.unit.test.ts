/**
 * plugins/shipwright/scripts/suppressions.unit.test.ts
 *
 * Unit tests for suppressions.ts — parse, match and expiry of
 * `.shipwright/suppressions.yml`. Pure functions; time is injected via Clock.
 */

import { describe, expect, test } from "bun:test";
import type { Clock } from "./clock.ts";
import {
  DEFAULT_ACCEPTED_RISK_DAYS,
  defaultExpiry,
  evaluateExpiry,
  findSuppression,
  parseSuppressions,
  type Suppression,
  SuppressionsError,
} from "./suppressions.ts";

const clockAt = (iso: string): Clock => ({ now: () => new Date(iso) });

const VALID = `
suppressions:
  - rule: osv
    match: { cve: CVE-2024-1234, package: lodash }
    status: accepted_risk
    reason: Not reachable from our code
    addedBy: dave
    date: 2026-01-01
    expires: 2026-04-01
  - rule: grype
    match: { cve: CVE-2024-9999, package: openssl }
    status: false_positive
    reason: Distro backport
    addedBy: dan
    date: "2026-01-02"
  - rule: entropy
    match: { file: src/a.ts, symbol: doThing }
    status: false_positive
    reason: Intentional
    addedBy: dan
    date: 2026-01-03
  - rule: posture
    match: { path: .github/workflows/ci.yml }
    status: accepted_risk
    reason: Tracked elsewhere
    addedBy: dave
    date: 2026-01-04
    expires: 2026-05-01
`;

function errorsOf(text: string): string[] {
  try {
    parseSuppressions(text);
  } catch (e) {
    expect(e).toBeInstanceOf(SuppressionsError);
    return (e as SuppressionsError).errors;
  }
  throw new Error("expected parse to throw");
}

describe("parseSuppressions", () => {
  test("parses valid entries and normalizes dates to YYYY-MM-DD", () => {
    const entries = parseSuppressions(VALID);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({
      rule: "osv",
      status: "accepted_risk",
      date: "2026-01-01",
      expires: "2026-04-01",
    });
    expect(entries[1]?.date).toBe("2026-01-02");
    expect(entries[1]?.expires).toBeUndefined();
  });

  test("empty / missing list yields no entries", () => {
    expect(parseSuppressions("")).toEqual([]);
    expect(parseSuppressions("suppressions: []")).toEqual([]);
  });

  test("rejects accepted_risk without expires", () => {
    const errs = errorsOf(`
suppressions:
  - rule: osv
    match: { cve: CVE-1, package: p }
    status: accepted_risk
    reason: x
    addedBy: a
    date: 2026-01-01
`);
    expect(errs.join("\n")).toMatch(
      /suppressions\[0\].*expires.*required.*accepted_risk/,
    );
  });

  test("rejects missing or blank reason", () => {
    const base = (reasonLine: string) => `
suppressions:
  - rule: posture
    match: { path: a }
    status: false_positive
${reasonLine}
    addedBy: a
    date: 2026-01-01
`;
    expect(errorsOf(base("")).join("\n")).toMatch(
      /suppressions\[0\].*reason.*required/,
    );
    expect(errorsOf(base('    reason: "  "')).join("\n")).toMatch(/reason/);
  });

  test("rejects false_positive with expires", () => {
    const errs = errorsOf(`
suppressions:
  - rule: posture
    match: { path: a }
    status: false_positive
    reason: r
    addedBy: a
    date: 2026-01-01
    expires: 2027-01-01
`);
    expect(errs.join("\n")).toMatch(/false_positive.*never expire/);
  });

  test("rejects unknown rule, status, bad dates and missing addedBy", () => {
    const errs = errorsOf(`
suppressions:
  - rule: nope
    match: { path: a }
    status: maybe
    reason: r
    date: 01/01/2026
`).join("\n");
    expect(errs).toMatch(/unknown rule "nope"/);
    expect(errs).toMatch(/status.*false_positive.*accepted_risk/);
    expect(errs).toMatch(/addedBy.*required/);
    expect(errs).toMatch(/date.*YYYY-MM-DD/);
  });

  test("rejects incomplete or line-number match keys", () => {
    const errs = errorsOf(`
suppressions:
  - rule: osv
    match: { cve: CVE-1 }
    status: false_positive
    reason: r
    addedBy: a
    date: 2026-01-01
  - rule: entropy
    match: { file: a.ts, symbol: f, line: 12 }
    status: false_positive
    reason: r
    addedBy: a
    date: 2026-01-01
`).join("\n");
    expect(errs).toMatch(/suppressions\[0\].*match\.package/);
    expect(errs).toMatch(/suppressions\[1\].*line/);
  });

  test("rejects expires before date and reports all errors together", () => {
    const errs = errorsOf(`
suppressions:
  - rule: posture
    match: { path: a }
    status: accepted_risk
    reason: r
    addedBy: a
    date: 2026-02-01
    expires: 2026-01-01
  - rule: posture
    status: false_positive
    reason: r
    addedBy: a
    date: 2026-01-01
`);
    expect(errs.length).toBeGreaterThanOrEqual(2);
    expect(errs.join("\n")).toMatch(/expires.*before/);
    expect(errs.join("\n")).toMatch(/suppressions\[1\].*match/);
  });

  test("rejects malformed yaml and non-list root", () => {
    expect(() => parseSuppressions("suppressions: [")).toThrow(
      SuppressionsError,
    );
    expect(errorsOf("suppressions: nope").join("\n")).toMatch(/must be a list/);
  });
});

describe("findSuppression (matching)", () => {
  const entries = parseSuppressions(VALID);
  const NOW = clockAt("2026-02-01T00:00:00Z");

  test("osv matches on cve + package", () => {
    expect(
      findSuppression(
        entries,
        { rule: "osv", cve: "CVE-2024-1234", package: "lodash" },
        NOW,
      )?.reason,
    ).toBe("Not reachable from our code");
    expect(
      findSuppression(
        entries,
        { rule: "osv", cve: "CVE-2024-1234", package: "other" },
        NOW,
      ),
    ).toBeUndefined();
    expect(
      findSuppression(
        entries,
        { rule: "osv", cve: "CVE-0000-0000", package: "lodash" },
        NOW,
      ),
    ).toBeUndefined();
  });

  test("grype matches on cve + package and rule must agree", () => {
    expect(
      findSuppression(
        entries,
        { rule: "grype", cve: "CVE-2024-9999", package: "openssl" },
        NOW,
      ),
    ).toBeDefined();
    expect(
      findSuppression(
        entries,
        { rule: "osv", cve: "CVE-2024-9999", package: "openssl" },
        NOW,
      ),
    ).toBeUndefined();
  });

  test("entropy matches on file + symbol", () => {
    expect(
      findSuppression(
        entries,
        { rule: "entropy", file: "src/a.ts", symbol: "doThing" },
        NOW,
      ),
    ).toBeDefined();
    expect(
      findSuppression(
        entries,
        { rule: "entropy", file: "src/a.ts", symbol: "x" },
        NOW,
      ),
    ).toBeUndefined();
    expect(
      findSuppression(
        entries,
        { rule: "entropy", file: "src/b.ts", symbol: "doThing" },
        NOW,
      ),
    ).toBeUndefined();
  });

  test("posture matches on path", () => {
    expect(
      findSuppression(
        entries,
        { rule: "posture", path: ".github/workflows/ci.yml" },
        NOW,
      ),
    ).toBeDefined();
    expect(
      findSuppression(entries, { rule: "posture", path: "other" }, NOW),
    ).toBeUndefined();
  });

  test("line numbers do not affect matching", () => {
    const a = findSuppression(
      entries,
      { rule: "entropy", file: "src/a.ts", symbol: "doThing", line: 10 },
      NOW,
    );
    const b = findSuppression(
      entries,
      { rule: "entropy", file: "src/a.ts", symbol: "doThing", line: 999 },
      NOW,
    );
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  test("CVE ids compare case-insensitively", () => {
    expect(
      findSuppression(
        entries,
        { rule: "osv", cve: "cve-2024-1234", package: "lodash" },
        NOW,
      ),
    ).toBeDefined();
  });
});

describe("expiry", () => {
  const parsed = parseSuppressions(VALID);
  const accepted = parsed[0] as Suppression;
  const falsePositive = parsed[1] as Suppression;

  test("accepted_risk is active through the whole expires day (UTC) and expired the next instant", () => {
    expect(
      evaluateExpiry(accepted, clockAt("2026-03-31T23:59:59Z")).expired,
    ).toBe(false);
    expect(
      evaluateExpiry(accepted, clockAt("2026-04-01T00:00:00Z")).expired,
    ).toBe(false);
    expect(
      evaluateExpiry(accepted, clockAt("2026-04-01T23:59:59.999Z")).expired,
    ).toBe(false);
    expect(
      evaluateExpiry(accepted, clockAt("2026-04-02T00:00:00Z")).expired,
    ).toBe(true);
  });

  test("reports whole days remaining (floored)", () => {
    expect(
      evaluateExpiry(accepted, clockAt("2026-03-30T12:00:00Z")).daysRemaining,
    ).toBe(2);
  });

  test("false_positive never expires", () => {
    const r = evaluateExpiry(falsePositive, clockAt("2099-01-01T00:00:00Z"));
    expect(r.expired).toBe(false);
    expect(r.daysRemaining).toBeNull();
  });

  test("findSuppression skips expired entries unless includeExpired", () => {
    const f = { rule: "osv", cve: "CVE-2024-1234", package: "lodash" } as const;
    expect(
      findSuppression(
        parseSuppressions(VALID),
        f,
        clockAt("2026-04-02T00:00:00Z"),
      ),
    ).toBeUndefined();
    expect(
      findSuppression(
        parseSuppressions(VALID),
        f,
        clockAt("2026-04-02T00:00:00Z"),
        { includeExpired: true },
      ),
    ).toBeDefined();
    expect(
      findSuppression(
        parseSuppressions(VALID),
        f,
        clockAt("2026-04-01T12:00:00Z"),
      ),
    ).toBeDefined();
  });

  test("defaultExpiry adds 90 days", () => {
    expect(DEFAULT_ACCEPTED_RISK_DAYS).toBe(90);
    expect(defaultExpiry("2026-01-01")).toBe("2026-04-01");
    expect(defaultExpiry("2026-01-01", 30)).toBe("2026-01-31");
  });
});
