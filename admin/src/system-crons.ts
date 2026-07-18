/**
 * agent/src/system-crons.ts
 * Default cron jobs seeded for a new agent.
 *
 * When a preCheck script is set, its stdout becomes the actual prompt sent to
 * Claude — the stored prompt field is only used as a fallback when the preCheck
 * script is not found in the plugin cache. Keep both in sync.
 */

export interface SystemCron {
  name: string;
  schedule: string;
  prompt: string;
  silent?: boolean;
  preCheck?: string;
  enabled: boolean;
  /**
   * Name of another SYSTEM_CRONS entry this cron is a phase/child of (e.g.
   * the four legacy pipeline crons are phases of "shipwright-loop"). When
   * set, reconcileSystemCrons() resolves the parent's row id for the same
   * agent and sets it as this cron's parentCronId — self-healing the link
   * on every agent boot with no manual migration step.
   */
  parentCron?: string;
}

export const SYSTEM_CRONS: readonly SystemCron[] = [
  {
    name: "shipwright-dev-task",
    schedule: "0,30 * * * *",
    prompt: "/shipwright:dev-task",
    silent: true,
    enabled: true,
    parentCron: "shipwright-loop",
  },
  {
    name: "shipwright-patch",
    schedule: "5,35 * * * *",
    prompt: "/shipwright:patch",
    silent: true,
    enabled: true,
    parentCron: "shipwright-loop",
  },
  {
    name: "shipwright-review",
    schedule: "15,45 * * * *",
    prompt: "/shipwright:review",
    silent: true,
    enabled: true,
    parentCron: "shipwright-loop",
  },
  {
    name: "shipwright-deploy",
    schedule: "20,50 * * * *",
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
    silent: true,
    preCheck: "shipwright:check-test-readiness.ts",
    enabled: false,
  },
  {
    name: "shipwright-docs-freshness",
    schedule: "0 7 * * *",
    prompt: "/shipwright:research-docs --auto",
    silent: true,
    preCheck: "shipwright:check-docs-freshness.ts",
    enabled: false,
  },
  {
    name: "learn-dream",
    schedule: "0 3 * * *",
    preCheck: "shipwright:check-learn-dream.ts",
    prompt: "/shipwright:learn-dream --since 1d --review",
    silent: true,
    enabled: false,
  },
  {
    name: "dependabot-triage",
    schedule: "0 8 * * *",
    prompt: "/shipwright:triage-dependabot-prs",
    silent: true,
    enabled: false,
  },
  {
    name: "entropy-patrol-maintenance",
    schedule: "0 4 * * 1",
    prompt:
      '/shipwright:entropy-scan\n/shipwright:entropy-fix\nAfter the fix run completes, write state/entropy-patrol-last-run.json: {"lastRun": "<ISO timestamp>"}. Use [silent] if no pr_worthy findings are found.',
    silent: true,
    enabled: false,
  },
  {
    name: "error-patrol-maintenance",
    schedule: "0 4 * * *",
    prompt:
      '/shipwright:error-scan\n/shipwright:error-fix\n/shipwright:error-resolve\nAfter the chain completes, write state/error-patrol-ledger.json\'s lastRun field: "<ISO timestamp>". Use [silent] if no new or regressed issues are found.',
    silent: true,
    preCheck: "shipwright:check-error-patrol.ts",
    enabled: false,
  },
] as const;
