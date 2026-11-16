#!/usr/bin/env bun
// CI failure classifier (BKH-1.1).
//
// Classifies a failed GitHub Actions run as an infra flake (checkout/runner/
// startup problem — the repo's own code never ran) or a real failure. Pure,
// standalone function plus an optional CLI taking the input as a JSON arg or
// via stdin.
//
// Deliberately has no dependency on @app-vitals/agent-lib or any other workspace
// package — plugins/shipwright must stay installable standalone (see
// plugins/shipwright/CLAUDE.md).
//
// CLI:
//   bun run plugins/shipwright/scripts/classify-ci-failure.ts '{"conclusion":"failure","jobs":[...],"failedStepLog":"..."}'

// ─── Types ────────────────────────────────────────────────────────────────────

export type CiStep = { name: string; conclusion: string | null };
export type CiJob = {
  name: string;
  conclusion: string | null;
  steps?: CiStep[];
};
export type CiFailureInput = {
  conclusion?: string | null;
  jobs?: CiJob[];
  failedStepLog?: string;
};
export type CiFailureResult = {
  classification: "infra-flake" | "real-failure";
  reason: string;
  scanNeverRan: boolean;
};

// ─── classifyCiFailure ────────────────────────────────────────────────────────
//
// Flake signatures (anything else, including unknown/malformed input, fails
// closed to real-failure):
//   1. Run conclusion "startup_failure".
//   2. The failed step is checkout (or early setup) — repo code never ran.
//   3. The log says "Repository not found" / "exit code 128" AND the failed
//      step is checkout/setup. Log text alone never makes a test/lint/build
//      step a flake.
//   4. Runner shutdown log ("The runner has received a shutdown signal") with
//      a cancelled run/job conclusion.
const BAD_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out"]);
const EARLY_STEP = /checkout|^set up job$|^(run )?actions\/setup-/i;
const GIT_LOG_FLAKE = /Repository not found|exit code 128/i;
const SHUTDOWN_LOG = /runner has received a shutdown signal|runner.*shutdown/i;
const SCAN_JOB = /scan|secret|gitleaks|osv|grype|trivy|codeql|security/i;

const real = (reason: string): CiFailureResult => ({
  classification: "real-failure",
  reason,
  scanNeverRan: false,
});

export function classifyCiFailure(input: CiFailureInput): CiFailureResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return real("unrecognised input; failing closed");
  }
  const jobs = Array.isArray(input.jobs) ? input.jobs : [];
  const log = typeof input.failedStepLog === "string" ? input.failedStepLog : "";

  const failedJob = jobs.find(
    (j) => j && typeof j.conclusion === "string" && BAD_CONCLUSIONS.has(j.conclusion),
  );
  const flake = (reason: string): CiFailureResult => ({
    classification: "infra-flake",
    reason,
    scanNeverRan: !!failedJob && SCAN_JOB.test(String(failedJob.name ?? "")),
  });

  if (input.conclusion === "startup_failure") {
    return flake("run conclusion is startup_failure");
  }

  const steps = Array.isArray(failedJob?.steps) ? failedJob.steps : [];
  const failedStep = steps.find(
    (s) => s && typeof s.conclusion === "string" && BAD_CONCLUSIONS.has(s.conclusion),
  );
  const stepName = typeof failedStep?.name === "string" ? failedStep.name : "";
  const early = EARLY_STEP.test(stepName);

  if (/checkout/i.test(stepName)) {
    return flake(`checkout step failed ("${stepName}") before repo code ran`);
  }
  if (early && GIT_LOG_FLAKE.test(log)) {
    return flake(`setup step "${stepName}" failed with a git/repo error in the log`);
  }
  const cancelled =
    input.conclusion === "cancelled" || failedJob?.conclusion === "cancelled";
  if (cancelled && SHUTDOWN_LOG.test(log)) {
    return flake("runner shutdown signal on a cancelled run");
  }
  if (early && SHUTDOWN_LOG.test(log)) {
    return flake(`runner shutdown during setup step "${stepName}"`);
  }

  return real(
    stepName
      ? `failed step "${stepName}" is not an infra signature`
      : "no infra-flake signature found",
  );
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const arg = process.argv[2];
  const raw = arg && arg.length > 0 ? arg : await Bun.stdin.text();
  let input: CiFailureInput = {};
  try {
    input = JSON.parse(raw);
  } catch {
    // malformed -> fails closed inside classifyCiFailure
  }
  console.log(JSON.stringify(classifyCiFailure(input)));
}
