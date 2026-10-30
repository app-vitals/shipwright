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
      name: "shipwright-deploy",
      schedule: "* * * * *",
      prompt: "/shipwright:deploy",
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
      name: "shipwright-test-readiness",
      schedule: "0 6 * * *",
      prompt: "/shipwright:test-readiness --full --publish",
      preCheck: "shipwright:check-test-readiness.ts",
      silent: true,
      enabled: false,
    },
    {
      name: "shipwright-docs-freshness",
      schedule: "0 7 * * *",
      prompt: "/shipwright:research-docs --auto",
      preCheck: "shipwright:check-docs-freshness.ts",
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
      name: "entropy-patrol-maintenance",
      schedule: "0 4 * * 1",
      prompt:
        '/shipwright:entropy-scan\n/shipwright:entropy-fix\nAfter the fix run completes, write state/entropy-patrol-last-run.json: {"lastRun": "<ISO timestamp>"}. Use [silent] if no pr_worthy findings are found.',
      preCheck: "shipwright:check-patrol-scope.ts",
      silent: true,
      enabled: false,
    },
    {
      name: "error-patrol-maintenance",
      schedule: "0 4 * * *",
      prompt:
        "/shipwright:error-scan\n/shipwright:error-fix\n/shipwright:error-resolve\nThese three commands are not independent suggestions -- invoke each one immediately after the previous one finishes, in this same session, using the Skill tool. Do not stop after a command's own output tells you to 'run /X next' (e.g. error-scan's summary) -- that phrasing is written for a standalone manual invocation, not this chained cron session. Continue automatically through all three commands before doing anything else.\nAfter the chain completes, write state/error-patrol-ledger.json's lastRun field: \"<ISO timestamp>\". Use [silent] if no new or regressed issues are found.",
      preCheck: "shipwright:check-error-patrol.ts",
      silent: true,
      enabled: false,
    },
    {
      name: "security-patrol-maintenance",
      schedule: "0 6 * * 1",
      prompt:
        '/shipwright:security-scan\n/shipwright:security-fix\nAfter the fix run completes, write state/security-patrol-last-run.json: {"lastRun": "<ISO timestamp>"}. Use [silent] if no pr_worthy findings are found.',
      preCheck: "shipwright:check-patrol-scope.ts",
      silent: true,
      enabled: false,
    },
    {
      name: "consolidation-patrol-maintenance",
      schedule: "0 5 * * 1",
      prompt:
        '/shipwright:consolidation-scan\n/shipwright:consolidation-fix\nAfter the chain completes, write state/consolidation-ledger.json\'s lastRun field: "<ISO timestamp>". Use [silent] if no ready_to_propose findings are found.',
      preCheck: "shipwright:check-consolidation-patrol.ts",
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
