/**
 * admin/src/coding/system-cron-form.unit.test.ts
 * Unit tests for the system-crons template form validation (SCR-1.4).
 */

import { describe, expect, it } from "bun:test";
import {
  MAX_DESCRIPTION_TEMPLATE_LENGTH,
  MAX_SCOPE_REPOS,
  MAX_TITLE_TEMPLATE_LENGTH,
  validateScopeForm,
  validateTemplateForm,
} from "./system-cron-form.ts";

describe("validateTemplateForm", () => {
  it("accepts non-empty templates using {repo}", () => {
    const r = validateTemplateForm({
      titleTemplate: "Audit: {repo}",
      descriptionTemplate: "Audit {repo}'s dependencies.",
    });
    expect(r).toEqual({
      ok: true,
      value: {
        titleTemplate: "Audit: {repo}",
        descriptionTemplate: "Audit {repo}'s dependencies.",
      },
      warnings: [],
    });
  });

  it("accepts templates with no placeholder", () => {
    expect(
      validateTemplateForm({
        titleTemplate: "Weekly",
        descriptionTemplate: "x",
      }).ok,
    ).toBe(true);
  });

  it("rejects empty, whitespace-only and missing templates", () => {
    const r = validateTemplateForm({
      titleTemplate: "  ",
      descriptionTemplate: undefined,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual([
        "Title template must not be empty.",
        "Description template must not be empty.",
      ]);
    }
  });

  it("rejects over-long templates", () => {
    const r = validateTemplateForm({
      titleTemplate: "a".repeat(MAX_TITLE_TEMPLATE_LENGTH + 1),
      descriptionTemplate: "b".repeat(MAX_DESCRIPTION_TEMPLATE_LENGTH + 1),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(2);
  });

  it("keeps the template verbatim (no trimming) and warns on unknown tokens", () => {
    const r = validateTemplateForm({
      titleTemplate: " {Repo} {repo} {{x}} ",
      descriptionTemplate: "ok",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.titleTemplate).toBe(" {Repo} {repo} {{x}} ");
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toContain("{Repo}");
      expect(r.warnings[0]).toContain("{x}");
      expect(r.warnings[0]).not.toContain("{repo},");
    }
  });
});

describe("validateScopeForm", () => {
  it("treats a missing scope as untouched (no change to the definition)", () => {
    expect(validateScopeForm({})).toEqual({ ok: true, value: undefined });
    expect(validateScopeForm({ repos: ["a/b"] })).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("'all' clears repos regardless of what was submitted", () => {
    expect(
      validateScopeForm({ repoScope: "all", repos: ["acme/web"] }),
    ).toEqual({ ok: true, value: { repoScope: "all", repos: [] } });
  });

  it("'selected' keeps trimmed, de-duplicated repos in first-seen order", () => {
    expect(
      validateScopeForm({
        repoScope: "selected",
        repos: [" acme/web ", "acme/api", "acme/web", ""],
      }),
    ).toEqual({
      ok: true,
      value: { repoScope: "selected", repos: ["acme/web", "acme/api"] },
    });
  });

  it("rejects 'selected' with nothing checked", () => {
    for (const repos of [undefined, [], ["", "  "]]) {
      const r = validateScopeForm({ repoScope: "selected", repos });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors).toEqual([
          "Select at least one repository, or choose All repositories.",
        ]);
      }
    }
  });

  it("rejects unknown scopes, malformed repos, and oversized selections", () => {
    const bad = validateScopeForm({ repoScope: "some" });
    expect(bad.ok).toBe(false);
    const malformed = validateScopeForm({
      repoScope: "selected",
      repos: ["not-a-repo", "acme/ok"],
    });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.errors[0]).toContain("not-a-repo");
    const many = validateScopeForm({
      repoScope: "selected",
      repos: Array.from({ length: MAX_SCOPE_REPOS + 1 }, (_, i) => `o/r${i}`),
    });
    expect(many.ok).toBe(false);
  });
});
