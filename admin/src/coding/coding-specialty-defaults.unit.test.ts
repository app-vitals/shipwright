/**
 * admin/src/coding/coding-specialty-defaults.unit.test.ts
 * Golden pins for the coding extension's specialtyDefaults() hook. The
 * defaults are the source of truth for the coding agent's system crons, tools
 * and plugins (specialties/coding/manifest.yaml was retired in CET-4.2), so the
 * expected values are hardcoded here rather than derived from them.
 */

import { describe, expect, it } from "bun:test";
import { AgentCronJobService } from "@app-vitals/agent-admin/agent-cron-jobs";
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
      "shipwright-merge",
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
      "shipwright-merge",
    ]) {
      expect(byName(name)?.parentCron).toBe("shipwright-loop");
    }
    expect(byName("shipwright-loop")?.parentCron).toBeUndefined();
  });

  it("shipwright-plan runs /shipwright:plan-session and ships disabled", () => {
    expect(byName("shipwright-plan")?.prompt).toBe("/shipwright:plan-session");
    expect(byName("shipwright-plan")?.enabled).toBe(false);
  });

  it("shipwright-merge runs /shipwright:merge and ships disabled", () => {
    expect(byName("shipwright-merge")?.prompt).toBe("/shipwright:merge");
    expect(byName("shipwright-merge")?.enabled).toBe(false);
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

  it("does not ship a shipwright-deploy cron (MPD-3.2)", () => {
    expect(byName("shipwright-deploy")).toBeUndefined();
    expect(crons.some((c) => c.prompt.includes("/shipwright:deploy"))).toBe(
      false,
    );
  });

  it("reconcileSystemCrons() deletes an existing shipwright-deploy child row (MPD-3.2)", async () => {
    // Minimal in-memory prisma double: one system loop row plus a stale
    // shipwright-deploy child row; reconcile must delete the latter only.
    const rows = [
      { id: "loop-1", name: "shipwright-loop", parentCronId: null },
      { id: "deploy-1", name: "shipwright-deploy", parentCronId: "loop-1" },
    ];
    const deletedIds: string[] = [];
    const tx = {
      agentCronJob: {
        update: async () => ({}),
        create: async ({ data }: { data: { name: string } }) => ({
          id: `new-${data.name}`,
        }),
        delete: async ({ where }: { where: { id: string } }) => {
          deletedIds.push(where.id);
        },
      },
    };
    const prisma = {
      agent: { findUnique: async () => ({ specialty: "coding" }) },
      agentCronJob: { findMany: async () => rows },
      $transaction: async (cb: (t: typeof tx) => Promise<void>) => cb(tx),
    };
    const service = new AgentCronJobService(
      // biome-ignore lint/suspicious/noExplicitAny: partial prisma double
      prisma as any,
      undefined,
      undefined,
      codingSpecialtyDefaults,
    );

    const result = await service.reconcileSystemCrons("agent-1");

    expect(deletedIds).toEqual(["deploy-1"]);
    expect(result.deleted).toBe(1);
  });
});
