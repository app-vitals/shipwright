/**
 * agent/src/system-crons.unit.test.ts
 * Unit tests for SYSTEM_CRONS definition.
 *
 * Validates structure and ensures all skill refs use the shipwright: namespace.
 */

import { describe, it, expect } from "bun:test";
import { SYSTEM_CRONS } from "./system-crons.ts";

describe("SYSTEM_CRONS", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(SYSTEM_CRONS)).toBe(true);
    expect(SYSTEM_CRONS.length).toBeGreaterThan(0);
  });

  it("all entries have required fields (name, schedule, prompt, enabled)", () => {
    for (const cron of SYSTEM_CRONS) {
      expect(typeof cron.name).toBe("string");
      expect(cron.name.length).toBeGreaterThan(0);
      expect(typeof cron.schedule).toBe("string");
      expect(cron.schedule.length).toBeGreaterThan(0);
      expect(typeof cron.prompt).toBe("string");
      expect(cron.prompt.length).toBeGreaterThan(0);
      expect(typeof cron.enabled).toBe("boolean");
    }
  });

  it("all entry names are unique", () => {
    const names = SYSTEM_CRONS.map((c) => c.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it("no entry uses legacy dependabot-review: skill namespace", () => {
    for (const cron of SYSTEM_CRONS) {
      expect(cron.prompt).not.toMatch(/dependabot-review:/);
      if (cron.preCheck) {
        expect(cron.preCheck).not.toMatch(/dependabot-review:/);
      }
    }
  });

  it("no entry uses legacy entropy-patrol: skill namespace", () => {
    for (const cron of SYSTEM_CRONS) {
      expect(cron.prompt).not.toMatch(/entropy-patrol:/);
      if (cron.preCheck) {
        expect(cron.preCheck).not.toMatch(/entropy-patrol:/);
      }
    }
  });

  it("no entry uses /learn-dream without shipwright: prefix", () => {
    for (const cron of SYSTEM_CRONS) {
      if (cron.prompt.includes("learn-dream")) {
        expect(cron.prompt).toMatch(/shipwright:learn-dream/);
      }
    }
  });

  it("all preCheck paths use shipwright: prefix", () => {
    for (const cron of SYSTEM_CRONS) {
      if (cron.preCheck) {
        expect(cron.preCheck).toMatch(/^shipwright:/);
      }
    }
  });
});
