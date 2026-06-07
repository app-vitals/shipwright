import { describe, expect, test } from "bun:test";
import { SYSTEM_CRONS } from "./system-crons.ts";

describe("SYSTEM_CRONS", () => {
  test("exports exactly eleven crons", () => {
    expect(SYSTEM_CRONS).toHaveLength(11);
  });

  test("cron names are the eleven expected crons", () => {
    const names = SYSTEM_CRONS.map((c) => c.name);
    expect(names).toContain("shipwright-dev-task");
    expect(names).toContain("shipwright-patch");
    expect(names).toContain("shipwright-review-patch");
    expect(names).toContain("shipwright-review");
    expect(names).toContain("shipwright-deploy");
    expect(names).toContain("shipwright-test-readiness");
    expect(names).toContain("shipwright-docs-freshness");
    expect(names).toContain("learn-dream");
    expect(names).toContain("dependabot-triage");
    expect(names).toContain("entropy-patrol-maintenance");
    expect(names).toContain("arc-queue-probe");
  });

  test("all crons have silent: true", () => {
    for (const cron of SYSTEM_CRONS) {
      expect(cron.silent).toBe(true);
    }
  });

  // ── Shipwright pipeline crons ───────────────────────────────────────────────

  test("shipwright-dev-task has enabled: true", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-dev-task");
    expect(cron?.enabled).toBe(true);
  });

  test("shipwright-dev-task has correct preCheck", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-dev-task");
    expect(cron?.preCheck).toBe("shipwright:check-dev-task.ts");
  });

  test("shipwright-dev-task prompt includes /shipwright:dev-task skill invocation", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-dev-task");
    expect(cron?.prompt).toContain("/shipwright:dev-task");
  });

  test("shipwright-patch has enabled: false", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-patch");
    expect(cron?.enabled).toBe(false);
  });

  test("shipwright-patch has correct preCheck", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-patch");
    expect(cron?.preCheck).toBe("shipwright:check-patch.ts");
  });

  test("shipwright-patch prompt includes /shipwright:patch skill invocation", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-patch");
    expect(cron?.prompt).toContain("/shipwright:patch");
  });

  test("shipwright-review-patch has enabled: true", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-review-patch");
    expect(cron?.enabled).toBe(true);
  });

  test("shipwright-review-patch has correct preCheck", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-review-patch");
    expect(cron?.preCheck).toBe("shipwright:check-review-patch.ts");
  });

  test("shipwright-review-patch prompt includes /shipwright:review-patch skill invocation", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-review-patch");
    expect(cron?.prompt).toContain("/shipwright:review-patch");
  });

  test("shipwright-review has enabled: false", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-review");
    expect(cron?.enabled).toBe(false);
  });

  test("shipwright-review has correct preCheck", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-review");
    expect(cron?.preCheck).toBe("shipwright:check-review.ts");
  });

  test("shipwright-review prompt includes /shipwright:review skill invocation", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-review");
    expect(cron?.prompt).toContain("/shipwright:review");
  });

  test("shipwright-deploy has enabled: false", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-deploy");
    expect(cron?.enabled).toBe(false);
  });

  test("shipwright-deploy has correct preCheck", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-deploy");
    expect(cron?.preCheck).toBe("shipwright:check-deploy.ts");
  });

  test("shipwright-deploy prompt includes /shipwright:deploy skill invocation", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-deploy");
    expect(cron?.prompt).toContain("/shipwright:deploy");
  });

  test("shipwright-test-readiness has enabled: false", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "shipwright-test-readiness",
    );
    expect(cron?.enabled).toBe(false);
  });

  test("shipwright-test-readiness has daily schedule 0 6 * * *", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "shipwright-test-readiness",
    );
    expect(cron?.schedule).toBe("0 6 * * *");
  });

  test("shipwright-test-readiness has no preCheck", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "shipwright-test-readiness",
    );
    expect(cron?.preCheck).toBeUndefined();
  });

  test("shipwright-test-readiness prompt includes /shipwright:test-readiness skill invocation", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "shipwright-test-readiness",
    );
    expect(cron?.prompt).toContain("/shipwright:test-readiness");
    expect(cron?.prompt).toContain("--full");
    expect(cron?.prompt).toContain("--publish");
  });

  test("shipwright-docs-freshness has enabled: false", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "shipwright-docs-freshness",
    );
    expect(cron?.enabled).toBe(false);
  });

  test("shipwright-docs-freshness has daily schedule 0 7 * * *", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "shipwright-docs-freshness",
    );
    expect(cron?.schedule).toBe("0 7 * * *");
  });

  test("shipwright-docs-freshness has correct preCheck", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "shipwright-docs-freshness",
    );
    expect(cron?.preCheck).toBe("shipwright:check-docs-freshness.ts");
  });

  test("shipwright-docs-freshness prompt includes /shipwright:research-docs skill invocation", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "shipwright-docs-freshness",
    );
    expect(cron?.prompt).toContain("/shipwright:research-docs");
  });

  test("polling crons have schedule */30 * * * *", () => {
    const pollingCrons = SYSTEM_CRONS.filter(
      (c) =>
        c.name !== "shipwright-test-readiness" &&
        c.name !== "shipwright-docs-freshness" &&
        c.name !== "learn-dream" &&
        c.name !== "dependabot-triage" &&
        c.name !== "entropy-patrol-maintenance" &&
        c.name !== "arc-queue-probe",
    );
    for (const cron of pollingCrons) {
      expect(cron.schedule).toBe("*/30 * * * *");
    }
  });

  // ── Absorbed plugin crons — shipwright: prefix ─────────────────────────────

  test("learn-dream cron has schedule 0 3 * * *", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "learn-dream");
    expect(cron?.schedule).toBe("0 3 * * *");
  });

  test("learn-dream cron has enabled: false", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "learn-dream");
    expect(cron?.enabled).toBe(false);
  });

  test("learn-dream prompt invokes /shipwright:learn-dream (absorbed from learning-loop)", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "learn-dream");
    expect(cron?.prompt).toContain("/shipwright:learn-dream");
    expect(cron?.prompt).not.toContain("/learn-dream ");
  });

  test("dependabot-triage cron has schedule 0 8 * * *", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "dependabot-triage");
    expect(cron?.schedule).toBe("0 8 * * *");
  });

  test("dependabot-triage cron has enabled: false", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "dependabot-triage");
    expect(cron?.enabled).toBe(false);
  });

  test("dependabot-triage prompt invokes shipwright:triage-dependabot-prs (absorbed from dependabot-review)", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "dependabot-triage");
    expect(cron?.prompt).toContain("/shipwright:triage-dependabot-prs");
    expect(cron?.prompt).not.toContain("dependabot-review:");
  });

  test("entropy-patrol-maintenance cron has schedule 0 4 * * 1", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "entropy-patrol-maintenance",
    );
    expect(cron?.schedule).toBe("0 4 * * 1");
  });

  test("entropy-patrol-maintenance cron has enabled: false", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "entropy-patrol-maintenance",
    );
    expect(cron?.enabled).toBe(false);
  });

  test("entropy-patrol-maintenance cron has no preCheck", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "entropy-patrol-maintenance",
    );
    expect(cron?.preCheck).toBeUndefined();
  });

  test("entropy-patrol-maintenance prompt invokes shipwright:entropy-scan and shipwright:entropy-fix (absorbed from entropy-patrol)", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "entropy-patrol-maintenance",
    );
    expect(cron?.prompt).toContain("/shipwright:entropy-scan");
    expect(cron?.prompt).toContain("/shipwright:entropy-fix");
    expect(cron?.prompt).not.toContain("entropy-patrol:");
    expect(cron?.prompt).toContain("entropy-patrol-last-run.json");
  });

  // ── arc-queue-probe ─────────────────────────────────────────────────────────

  test("arc-queue-probe has schedule 0 9 * * *", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "arc-queue-probe");
    expect(cron?.schedule).toBe("0 9 * * *");
  });

  test("arc-queue-probe has enabled: false", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "arc-queue-probe");
    expect(cron?.enabled).toBe(false);
  });

  test("arc-queue-probe has no preCheck", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "arc-queue-probe");
    expect(cron?.preCheck).toBeUndefined();
  });

  test("arc-queue-probe prompt contains the script invocation", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "arc-queue-probe");
    expect(cron?.prompt).toContain("bun scripts/arc-queue-probe.ts");
  });

  // ── No old plugin-prefix refs anywhere in prompts ──────────────────────────

  test("no cron prompt contains old dependabot-review: prefix", () => {
    for (const cron of SYSTEM_CRONS) {
      expect(cron.prompt).not.toContain("dependabot-review:");
    }
  });

  test("no cron prompt contains old entropy-patrol: prefix", () => {
    for (const cron of SYSTEM_CRONS) {
      expect(cron.prompt).not.toContain("entropy-patrol:");
    }
  });

  test("no cron prompt contains old bare /learn-dream invocation", () => {
    for (const cron of SYSTEM_CRONS) {
      // /shipwright:learn-dream is fine; /learn-dream (without shipwright:) is stale
      expect(cron.prompt.replace("/shipwright:learn-dream", "")).not.toContain(
        "/learn-dream",
      );
    }
  });
});
