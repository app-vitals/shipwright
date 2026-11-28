/**
 * admin/src/coding/coding-specialty-defaults.ts
 *
 * The coding agent's default system crons, tools and plugin, supplied as code
 * through the AdminExtension specialtyDefaults() hook (CET-4.1). These are the
 * source of truth now that specialties/coding/manifest.yaml is retired (CET-4.2);
 * coding-specialty-defaults.unit.test.ts pins them.
 */

import type { SpecialtyDefaults } from "@app-vitals/agent-admin/specialty-defaults";

export const CODING_SPECIALTY_NAME = "coding";

export const CODING_SPECIALTY_DEFAULTS: SpecialtyDefaults = {
  crons: [
    {
      name: "shipwright-plan",
      schedule: "* * * * *",
      prompt: "/shipwright:plan-session",
      silent: true,
      enabled: false,
      parentCron: "shipwright-loop",
    },
    {
      name: "shipwright-dev-task",
      schedule: "* * * * *",
      prompt: "/shipwright:dev-task",
      silent: true,
      enabled: true,
      parentCron: "shipwright-loop",
    },
    {
      name: "shipwright-patch",
      schedule: "* * * * *",
      prompt: "/shipwright:patch",
      silent: true,
      enabled: true,
      parentCron: "shipwright-loop",
    },
    {
      name: "shipwright-review",
      schedule: "* * * * *",
      prompt: "/shipwright:review",
      silent: true,
      enabled: true,
      parentCron: "shipwright-loop",
    },
    {
      name: "shipwright-merge",
      schedule: "* * * * *",
      prompt: "/shipwright:merge",
      silent: true,
      enabled: false,
      parentCron: "shipwright-loop",
    },
    {
      name: "shipwright-loop",
      schedule: "* * * * *",
      prompt:
        "internal: dispatched via handleLoopCronRequest, not run through Claude",
      silent: true,
      enabled: false,
    },
    {
      name: "learn-dream",
      schedule: "0 3 * * *",
      prompt: "/shipwright:learn-dream --since 1d --review",
      preCheck: "shipwright:check-learn-dream.ts",
      silent: true,
      enabled: false,
    },
    {
      name: "prompt-audit-maintenance",
      schedule: "0 7 * * 1",
      prompt: "/shipwright:prompt-scan --with-doctor\n/shipwright:prompt-fix",
      preCheck: "shipwright:check-prompt-audit.ts",
      silent: true,
      enabled: false,
    },
  ],
  tools: [
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
  ],
  plugins: ["shipwright"],
};

/** The extension's specialtyDefaults() hook: coding's defaults, nothing else. */
export function codingSpecialtyDefaults(
  specialty: string,
): SpecialtyDefaults | undefined {
  return specialty === CODING_SPECIALTY_NAME
    ? CODING_SPECIALTY_DEFAULTS
    : undefined;
}
