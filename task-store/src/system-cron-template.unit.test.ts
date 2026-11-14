// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these tests assert that literal ${x} sequences in templates are NOT evaluated
/**
 * task-store/src/system-cron-template.unit.test.ts
 *
 * Unit tests for the pure system-cron helpers (SCR-1.1): `{repo}` template
 * rendering, the deterministic slot format derived from `scheduledFor`, and
 * the deterministic per-repo task id.
 */

import { describe, expect, it } from "bun:test";
import {
  formatSlot,
  isValidCronId,
  isValidSystemCronRepo,
  parseScheduledFor,
  renderRepoTemplate,
  systemCronTaskId,
} from "./system-cron-template.ts";

describe("renderRepoTemplate", () => {
  it("substitutes {repo} with the full org/repo string", () => {
    expect(renderRepoTemplate("Audit {repo}", "acme/widgets")).toBe(
      "Audit acme/widgets",
    );
  });

  it("substitutes every occurrence of {repo}", () => {
    expect(
      renderRepoTemplate("{repo}: run checks on {repo} today", "acme/w"),
    ).toBe("acme/w: run checks on acme/w today");
  });

  it("returns a template with no placeholder unchanged", () => {
    expect(renderRepoTemplate("nothing to see", "acme/w")).toBe(
      "nothing to see",
    );
  });

  it("leaves ${x} literal — no JS template-literal evaluation", () => {
    expect(renderRepoTemplate("a ${x} b ${repo}", "acme/w")).toBe(
      "a ${x} b $acme/w",
    );
  });

  it("leaves {{x}} literal — no mustache/handlebars evaluation", () => {
    expect(renderRepoTemplate("{{x}} and {{ repo }}", "acme/w")).toBe(
      "{{x}} and {{ repo }}",
    );
  });

  it("renders {{repo}} as {acme/w} — plain substitution of the inner {repo} only", () => {
    expect(renderRepoTemplate("{{repo}}", "acme/w")).toBe("{acme/w}");
  });

  it("leaves other {placeholders} literal", () => {
    expect(
      renderRepoTemplate("{other} {owner} {REPO} { repo } {repo}", "acme/w"),
    ).toBe("{other} {owner} {REPO} { repo } acme/w");
  });

  it("does not treat $-sequences in the repo value as replacement patterns", () => {
    // String.prototype.replace would interpret `$&` / `$1` in a replacement
    // string; plain substitution must insert the value verbatim.
    expect(renderRepoTemplate("x {repo} y", "a$&b/c$1")).toBe("x a$&b/c$1 y");
  });

  it("does not re-render a {repo} that appears inside the substituted value", () => {
    expect(renderRepoTemplate("{repo}", "{repo}/x")).toBe("{repo}/x");
  });

  it("leaves arbitrary code-looking expressions untouched", () => {
    const tpl = "<%= process.env.SECRET %> #{1+1} {{constructor}} ${1+1}";
    expect(renderRepoTemplate(tpl, "acme/w")).toBe(tpl);
  });
});

describe("parseScheduledFor", () => {
  it("parses a UTC ISO timestamp", () => {
    expect(parseScheduledFor("2026-11-14T09:00:00Z")?.toISOString()).toBe(
      "2026-11-14T09:00:00.000Z",
    );
  });

  it("normalizes an explicit offset to UTC", () => {
    expect(parseScheduledFor("2026-11-14T04:00:00-05:00")?.toISOString()).toBe(
      "2026-11-14T09:00:00.000Z",
    );
  });

  it("truncates sub-second precision so equivalent instants share one slot", () => {
    expect(parseScheduledFor("2026-11-14T09:00:00.999Z")?.toISOString()).toBe(
      "2026-11-14T09:00:00.000Z",
    );
  });

  it("rejects a timestamp with no timezone designator (ambiguous)", () => {
    expect(parseScheduledFor("2026-11-14T09:00:00")).toBeNull();
  });

  it("rejects garbage and non-strings", () => {
    expect(parseScheduledFor("tomorrow")).toBeNull();
    expect(parseScheduledFor("")).toBeNull();
    expect(parseScheduledFor(12345)).toBeNull();
    expect(parseScheduledFor(undefined)).toBeNull();
  });
});

describe("formatSlot", () => {
  it("formats as compact UTC YYYYMMDDTHHMMSSZ", () => {
    expect(formatSlot(new Date("2026-11-14T09:05:07.000Z"))).toBe(
      "20261114T090507Z",
    );
  });

  it("zero-pads every field", () => {
    expect(formatSlot(new Date("2027-01-02T03:04:05.000Z"))).toBe(
      "20270102T030405Z",
    );
  });
});

describe("systemCronTaskId", () => {
  it("builds SC-{cron}-{slot}-{owner}-{repo}", () => {
    expect(
      systemCronTaskId("dep-audit", "20261114T090000Z", "acme/widgets"),
    ).toBe("SC-dep-audit-20261114T090000Z-acme-widgets");
  });

  it("is deterministic for the same inputs", () => {
    const a = systemCronTaskId("c", "20261114T090000Z", "o/r");
    const b = systemCronTaskId("c", "20261114T090000Z", "o/r");
    expect(a).toBe(b);
  });
});

describe("isValidCronId", () => {
  it("accepts lowercase slugs", () => {
    expect(isValidCronId("dep-audit")).toBe(true);
    expect(isValidCronId("a1")).toBe(true);
  });

  it("rejects uppercase, spaces, slashes, leading hyphens and empty", () => {
    expect(isValidCronId("Dep")).toBe(false);
    expect(isValidCronId("a b")).toBe(false);
    expect(isValidCronId("a/b")).toBe(false);
    expect(isValidCronId("-a")).toBe(false);
    expect(isValidCronId("")).toBe(false);
  });
});

describe("isValidSystemCronRepo", () => {
  it("accepts org/repo with GitHub name characters", () => {
    expect(isValidSystemCronRepo("acme/widgets")).toBe(true);
    expect(isValidSystemCronRepo("a-b/c.d_e")).toBe(true);
  });

  it("rejects malformed repos", () => {
    expect(isValidSystemCronRepo("widgets")).toBe(false);
    expect(isValidSystemCronRepo("a/b/c")).toBe(false);
    expect(isValidSystemCronRepo("a /b")).toBe(false);
    expect(isValidSystemCronRepo("/b")).toBe(false);
  });
});
