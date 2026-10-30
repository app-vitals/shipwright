/**
 * admin/src/coding/coding-specialty-defaults.unit.test.ts
 * Golden pins for the coding extension's specialtyDefaults() hook. The
 * defaults are the source of truth for the coding agent's system crons, tools
 * and plugins (specialties/coding/manifest.yaml was retired in CET-4.2), so the
 * expected values are hardcoded here rather than derived from them.
 */

import { describe, expect, it } from "bun:test";
import { codingAdminExtension } from "./coding-admin-extension.ts";
import {
  CODING_SPECIALTY_DEFAULTS,
  codingSpecialtyDefaults,
} from "./coding-specialty-defaults.ts";

describe("coding specialtyDefaults hook", () => {
  const defaults = codingAdminExtension.specialtyDefaults?.("coding");
  const crons = defaults?.crons ?? [];
  const byName = (name: string) => crons.find((c) => c.name === name);

  it("is wired on the coding extension", () => {
    expect(defaults).toBe(CODING_SPECIALTY_DEFAULTS);
  });

  it("returns exactly the 14 system crons, by name and in order", () => {
    expect(crons.map((c) => c.name)).toEqual([
      "shipwright-plan",
      "shipwright-dev-task",
      "shipwright-patch",
      "shipwright-review",
      "shipwright-deploy",
      "shipwright-loop",
      "shipwright-test-readiness",
      "shipwright-docs-freshness",
      "learn-dream",
      "entropy-patrol-maintenance",
      "error-patrol-maintenance",
      "security-patrol-maintenance",
      "consolidation-patrol-maintenance",
      "prompt-audit-maintenance",
    ]);
  });

  it("every cron is silent and every parentCron names another cron in the list", () => {
    const names = new Set(crons.map((c) => c.name));
    for (const cron of crons) {
      expect(cron.silent).toBe(true);
      if (cron.parentCron) expect(names.has(cron.parentCron)).toBe(true);
    }
  });

  it("the pipeline phases are children of shipwright-loop", () => {
    for (const name of [
      "shipwright-plan",
      "shipwright-dev-task",
      "shipwright-patch",
      "shipwright-review",
      "shipwright-deploy",
    ]) {
      expect(byName(name)?.parentCron).toBe("shipwright-loop");
    }
    expect(byName("shipwright-loop")?.parentCron).toBeUndefined();
  });

  it("shipwright-plan runs /shipwright:plan-session and ships disabled", () => {
    expect(byName("shipwright-plan")?.prompt).toBe("/shipwright:plan-session");
    expect(byName("shipwright-plan")?.enabled).toBe(false);
  });

  it("only the dev-task, patch and review phases ship enabled", () => {
    expect(crons.filter((c) => c.enabled !== false).map((c) => c.name)).toEqual(
      ["shipwright-dev-task", "shipwright-patch", "shipwright-review"],
    );
  });

  it("error-patrol-maintenance prompt carries the explicit chaining instruction", () => {
    const prompt = byName("error-patrol-maintenance")?.prompt ?? "";
    for (const keyword of [
      "invoke each one immediately",
      "Do not stop after",
      "Continue automatically",
    ]) {
      expect(prompt).toContain(keyword);
    }
  });

  it("prompt-audit-maintenance has the weekly scan + fix prompt and preCheck", () => {
    const cron = byName("prompt-audit-maintenance");
    expect(cron?.schedule).toBe("0 7 * * 1");
    expect(cron?.prompt).toContain("/shipwright:prompt-scan --with-doctor");
    expect(cron?.prompt).toContain("/shipwright:prompt-fix");
    expect(cron?.preCheck).toBe("shipwright:check-prompt-audit.ts");
    expect(cron?.enabled).toBe(false);
  });

  it("returns the full tool set, in order", () => {
    expect(defaults?.tools).toEqual([
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash",
      "WebSearch",
      "WebFetch",
      "Skill",
      "Agent",
      "Monitor",
    ]);
  });

  it("returns the shipwright plugin", () => {
    expect(defaults?.plugins).toEqual(["shipwright"]);
  });

  it("returns nothing for other specialties", () => {
    expect(codingSpecialtyDefaults("specialist")).toBeUndefined();
  });
});
