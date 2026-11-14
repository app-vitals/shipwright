/**
 * admin/src/coding/system-cron-form.unit.test.ts
 * Unit tests for the system-crons template form validation (SCR-1.4).
 */

import { describe, expect, it } from "bun:test";
import {
  MAX_DESCRIPTION_TEMPLATE_LENGTH,
  MAX_TITLE_TEMPLATE_LENGTH,
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
