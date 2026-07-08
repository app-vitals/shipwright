import { describe, expect, test } from "bun:test";
import { SYSTEM_CRONS } from "./system-crons.ts";

/**
 * Expands the minute field of a 5-field cron schedule into the set of
 * minutes-past-the-hour it fires on. Supports plain numbers, comma lists
 * (e.g. "0,30"), and step expressions (star followed by slash and a step,
 * e.g. every-N-minutes). Sufficient for the schedules used in SYSTEM_CRONS —
 * not a general-purpose cron parser.
 */
function expandMinuteField(schedule: string): number[] {
  const minuteField = schedule.trim().split(/\s+/)[0];
  if (minuteField === undefined) {
    throw new Error(`schedule has no minute field: ${schedule}`);
  }
  const stepMatch = minuteField.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = Number(stepMatch[1]);
    const minutes: number[] = [];
    for (let m = 0; m < 60; m += step) minutes.push(m);
    return minutes;
  }
  if (minuteField === "*") {
    return Array.from({ length: 60 }, (_, m) => m);
  }
  return minuteField.split(",").map((n) => Number(n));
}

const PIPELINE_CRON_NAMES = [
  "shipwright-dev-task",
  "shipwright-patch",
  "shipwright-review-patch",
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

describe("SYSTEM_CRONS pipeline schedule staggering", () => {
  test("each pipeline cron fires on exactly 2 minutes, 30 minutes apart", () => {
    for (const cron of pipelineCrons()) {
      const minutes = expandMinuteField(cron.schedule);
      expect(minutes).toHaveLength(2);
      const [first, second] = minutes;
      expect(second === undefined || first === undefined).toBe(false);
      expect((second ?? 0) - (first ?? 0)).toBe(30);
    }
  });

  test("no two pipeline SYSTEM_CRONS entries fire in the same minute", () => {
    const minuteSets = pipelineCrons().map((cron) => ({
      name: cron.name,
      minutes: expandMinuteField(cron.schedule),
    }));
    for (const [i, a] of minuteSets.entries()) {
      for (const b of minuteSets.slice(i + 1)) {
        const overlap = a.minutes.filter((m) => b.minutes.includes(m));
        expect(overlap).toEqual([]);
      }
    }
  });

  test("pipeline crons keep the current expected staggered schedules", () => {
    const expected: Record<(typeof PIPELINE_CRON_NAMES)[number], string> = {
      "shipwright-dev-task": "0,30 * * * *",
      "shipwright-patch": "5,35 * * * *",
      "shipwright-review-patch": "10,40 * * * *",
      "shipwright-review": "15,45 * * * *",
      "shipwright-deploy": "20,50 * * * *",
    };
    for (const cron of pipelineCrons()) {
      expect(cron.schedule).toBe(
        expected[cron.name as (typeof PIPELINE_CRON_NAMES)[number]],
      );
    }
  });

  test("daily/weekly SYSTEM_CRONS schedules are unchanged", () => {
    const expected: Record<string, string> = {
      "shipwright-test-readiness": "0 6 * * *",
      "shipwright-docs-freshness": "0 7 * * *",
      "learn-dream": "0 3 * * *",
      "dependabot-triage": "0 8 * * *",
      "entropy-patrol-maintenance": "0 4 * * 1",
    };
    for (const [name, schedule] of Object.entries(expected)) {
      const cron = SYSTEM_CRONS.find((c) => c.name === name);
      expect(cron?.schedule).toBe(schedule);
    }
  });
});

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

  test("polling crons keep a 30-minute cadence, staggered to distinct minutes", () => {
    // See the "SYSTEM_CRONS pipeline schedule staggering" describe block above
    // for the collision-detection assertions. This test only pins the cadence.
    const pollingCrons = SYSTEM_CRONS.filter(
      (c) =>
        c.name !== "shipwright-test-readiness" &&
        c.name !== "shipwright-docs-freshness" &&
        c.name !== "learn-dream" &&
        c.name !== "dependabot-triage" &&
        c.name !== "entropy-patrol-maintenance" &&
        c.name !== "shipwright-loop",
    );
    for (const cron of pollingCrons) {
      expect(cron.schedule).toMatch(/^\d+,\d+ \* \* \* \*$/);
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
