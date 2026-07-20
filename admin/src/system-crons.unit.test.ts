import { describe, expect, test } from "bun:test";
import { SYSTEM_CRONS } from "./system-crons.ts";

const PIPELINE_CRON_NAMES = [
  "shipwright-dev-task",
  "shipwright-patch",
  "shipwright-review",
  "shipwright-deploy",
] as const;

function pipelineCrons() {
  return PIPELINE_CRON_NAMES.map((name) => {
    const cron = SYSTEM_CRONS.find((c) => c.name === name);
    if (!cron) throw new Error(`missing system cron: ${name}`);
    return cron;
  });
}

describe("SYSTEM_CRONS pipeline schedule matches parent", () => {
  test("each pipeline cron's schedule equals the shipwright-loop entry's schedule", () => {
    const parent = SYSTEM_CRONS.find((c) => c.name === "shipwright-loop");
    if (!parent) throw new Error("missing system cron: shipwright-loop");
    for (const cron of pipelineCrons()) {
      expect(cron.schedule).toBe(parent.schedule);
    }
  });
});

describe("SYSTEM_CRONS", () => {
  test("daily/weekly SYSTEM_CRONS schedules are unchanged", () => {
    const expected: Record<string, string> = {
      "shipwright-test-readiness": "0 6 * * *",
      "shipwright-docs-freshness": "0 7 * * *",
      "learn-dream": "0 3 * * *",
      "dependabot-triage": "0 8 * * *",
      "entropy-patrol-maintenance": "0 4 * * 1",
      "error-patrol-maintenance": "0 4 * * *",
      "security-patrol-maintenance": "0 6 * * 1",
      "consolidation-patrol-maintenance": "0 5 * * 1",
    };
    for (const [name, schedule] of Object.entries(expected)) {
      const cron = SYSTEM_CRONS.find((c) => c.name === name);
      expect(cron?.schedule).toBe(schedule);
    }
  });

  test("exports exactly thirteen crons", () => {
    expect(SYSTEM_CRONS).toHaveLength(13);
  });

  test("cron names are the thirteen expected crons", () => {
    const names = SYSTEM_CRONS.map((c) => c.name);
    expect(names).toContain("shipwright-dev-task");
    expect(names).toContain("shipwright-patch");
    expect(names).toContain("shipwright-review");
    expect(names).toContain("shipwright-deploy");
    expect(names).toContain("shipwright-test-readiness");
    expect(names).toContain("shipwright-docs-freshness");
    expect(names).toContain("learn-dream");
    expect(names).toContain("dependabot-triage");
    expect(names).toContain("entropy-patrol-maintenance");
    expect(names).toContain("error-patrol-maintenance");
    expect(names).toContain("security-patrol-maintenance");
    expect(names).toContain("consolidation-patrol-maintenance");
    expect(names).toContain("shipwright-loop");
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

  test("shipwright-dev-task has no preCheck — the legacy CLI script was removed", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-dev-task");
    expect(cron?.preCheck).toBeUndefined();
  });

  test("shipwright-dev-task prompt includes /shipwright:dev-task skill invocation", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-dev-task");
    expect(cron?.prompt).toContain("/shipwright:dev-task");
  });

  test("shipwright-patch has enabled: true", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-patch");
    expect(cron?.enabled).toBe(true);
  });

  test("shipwright-patch has no preCheck — the legacy CLI script was removed", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-patch");
    expect(cron?.preCheck).toBeUndefined();
  });

  test("shipwright-patch prompt includes /shipwright:patch skill invocation", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-patch");
    expect(cron?.prompt).toContain("/shipwright:patch");
  });

  test("shipwright-review has enabled: true", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-review");
    expect(cron?.enabled).toBe(true);
  });

  test("shipwright-review has no preCheck — the legacy CLI script was removed", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-review");
    expect(cron?.preCheck).toBeUndefined();
  });

  test("shipwright-review prompt includes /shipwright:review skill invocation", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-review");
    expect(cron?.prompt).toContain("/shipwright:review");
  });

  test("shipwright-deploy has enabled: false", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-deploy");
    expect(cron?.enabled).toBe(false);
  });

  test("shipwright-deploy has no preCheck — the legacy CLI script was removed", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-deploy");
    expect(cron?.preCheck).toBeUndefined();
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

  test("shipwright-test-readiness has correct preCheck", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "shipwright-test-readiness",
    );
    expect(cron?.preCheck).toBe("shipwright:check-test-readiness.ts");
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

  test("learn-dream cron has correct preCheck", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "learn-dream");
    expect(cron?.preCheck).toBe("shipwright:check-learn-dream.ts");
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

  test("security-patrol-maintenance cron has schedule 0 6 * * 1", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "security-patrol-maintenance",
    );
    expect(cron?.schedule).toBe("0 6 * * 1");
  });

  test("security-patrol-maintenance cron has enabled: false", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "security-patrol-maintenance",
    );
    expect(cron?.enabled).toBe(false);
  });

  test("security-patrol-maintenance cron has no preCheck", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "security-patrol-maintenance",
    );
    expect(cron?.preCheck).toBeUndefined();
  });

  test("security-patrol-maintenance prompt invokes /shipwright:security-scan and /shipwright:security-fix", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "security-patrol-maintenance",
    );
    expect(cron?.prompt).toContain("/shipwright:security-scan");
    expect(cron?.prompt).toContain("/shipwright:security-fix");
  });

  test("security-patrol-maintenance prompt writes security-patrol-last-run.json", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "security-patrol-maintenance",
    );
    expect(cron?.prompt).toContain("security-patrol-last-run.json");
  });

  test("security-patrol-maintenance prompt uses [silent] when no pr_worthy findings are found", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "security-patrol-maintenance",
    );
    expect(cron?.prompt).toContain("[silent]");
  });

  test("error-patrol-maintenance cron has schedule 0 4 * * *", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "error-patrol-maintenance",
    );
    expect(cron?.schedule).toBe("0 4 * * *");
  });

  test("error-patrol-maintenance cron has enabled: false", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "error-patrol-maintenance",
    );
    expect(cron?.enabled).toBe(false);
  });

  test("error-patrol-maintenance cron has correct preCheck", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "error-patrol-maintenance",
    );
    expect(cron?.preCheck).toBe("shipwright:check-error-patrol.ts");
  });

  test("error-patrol-maintenance prompt chains /shipwright:error-scan, /shipwright:error-fix, and /shipwright:error-resolve", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "error-patrol-maintenance",
    );
    expect(cron?.prompt).toContain("/shipwright:error-scan");
    expect(cron?.prompt).toContain("/shipwright:error-fix");
    expect(cron?.prompt).toContain("/shipwright:error-resolve");
  });

  test("error-patrol-maintenance prompt writes error-patrol-ledger.json's lastRun field, not a separate last-run file", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "error-patrol-maintenance",
    );
    expect(cron?.prompt).toContain("error-patrol-ledger.json");
    expect(cron?.prompt).toContain("lastRun");
    expect(cron?.prompt).not.toContain("error-patrol-last-run.json");
  });

  test("error-patrol-maintenance prompt uses [silent] when nothing new was found", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "error-patrol-maintenance",
    );
    expect(cron?.prompt).toContain("[silent]");
  });

  test("consolidation-patrol-maintenance cron has schedule 0 5 * * 1", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "consolidation-patrol-maintenance",
    );
    expect(cron?.schedule).toBe("0 5 * * 1");
  });

  test("consolidation-patrol-maintenance cron has enabled: false", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "consolidation-patrol-maintenance",
    );
    expect(cron?.enabled).toBe(false);
  });

  test("consolidation-patrol-maintenance cron has correct preCheck", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "consolidation-patrol-maintenance",
    );
    expect(cron?.preCheck).toBe("shipwright:check-consolidation-patrol.ts");
  });

  test("consolidation-patrol-maintenance prompt chains /shipwright:consolidation-scan and /shipwright:consolidation-fix", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "consolidation-patrol-maintenance",
    );
    expect(cron?.prompt).toContain("/shipwright:consolidation-scan");
    expect(cron?.prompt).toContain("/shipwright:consolidation-fix");
  });

  test("consolidation-patrol-maintenance prompt writes consolidation-ledger.json's lastRun field, not a separate last-run file", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "consolidation-patrol-maintenance",
    );
    expect(cron?.prompt).toContain("consolidation-ledger.json");
    expect(cron?.prompt).toContain("lastRun");
    expect(cron?.prompt).not.toContain("consolidation-patrol-last-run.json");
  });

  test("consolidation-patrol-maintenance prompt uses [silent] when no ready_to_propose findings are found", () => {
    const cron = SYSTEM_CRONS.find(
      (c) => c.name === "consolidation-patrol-maintenance",
    );
    expect(cron?.prompt).toContain("[silent]");
    expect(cron?.prompt).toContain("ready_to_propose");
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

describe("shipwright-loop", () => {
  test("has a 1-minute cron schedule", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-loop");
    expect(cron?.schedule).toBe("* * * * *");
  });

  test("has enabled: false — new system crons always ship disabled", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-loop");
    expect(cron?.enabled).toBe(false);
  });

  test("has silent: true", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-loop");
    expect(cron?.silent).toBe(true);
  });

  test("has no preCheck — the loop has its own toggle-reading logic instead", () => {
    const cron = SYSTEM_CRONS.find((c) => c.name === "shipwright-loop");
    expect(cron?.preCheck).toBeUndefined();
  });
});
