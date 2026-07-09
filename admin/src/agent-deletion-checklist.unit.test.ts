/**
 * admin/src/agent-deletion-checklist.unit.test.ts
 * Unit tests for the pure agent-deletion manual-steps checklist builder. No
 * I/O, no network, no fs — these assert output shape/content only.
 */

import { describe, expect, it } from "bun:test";
import {
  type ManualStep,
  buildManualStepsChecklist,
} from "./agent-deletion-checklist.ts";

describe("buildManualStepsChecklist — named keys", () => {
  it("produces a specific instruction for GH_TOKEN", () => {
    const steps = buildManualStepsChecklist([
      { key: "GH_TOKEN", secret: true },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0].key).toBe("GH_TOKEN");
    expect(steps[0].message).toContain("github.com/settings/tokens");
  });

  it("produces a specific instruction for ANTHROPIC_API_KEY", () => {
    const steps = buildManualStepsChecklist([
      { key: "ANTHROPIC_API_KEY", secret: true },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0].key).toBe("ANTHROPIC_API_KEY");
    expect(steps[0].message.toLowerCase()).toContain("anthropic console");
  });

  it("produces a specific instruction for CLAUDE_CODE_OAUTH_TOKEN", () => {
    const steps = buildManualStepsChecklist([
      { key: "CLAUDE_CODE_OAUTH_TOKEN", secret: true },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0].key).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(steps[0].message).toContain("claude auth logout");
  });
});

describe("buildManualStepsChecklist — excluded Slack keys", () => {
  it("produces no checklist entry for SLACK_APP_ID, SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN even when secret: true", () => {
    const steps = buildManualStepsChecklist([
      { key: "SLACK_APP_ID", secret: true },
      { key: "SLACK_SIGNING_SECRET", secret: true },
      { key: "SLACK_BOT_TOKEN", secret: true },
    ]);
    expect(steps).toHaveLength(0);
  });
});

describe("buildManualStepsChecklist — generic/custom secrets", () => {
  it("produces the generic message for LINEAR_API_KEY", () => {
    const steps = buildManualStepsChecklist([
      { key: "LINEAR_API_KEY", secret: true },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0].key).toBe("LINEAR_API_KEY");
    expect(steps[0].message).toBe(
      "Custom secret 'LINEAR_API_KEY' was added manually and has no automated revocation — verify whether it needs to be revoked at the source.",
    );
  });

  it("produces the generic message for VITALS_OS_API_KEY", () => {
    const steps = buildManualStepsChecklist([
      { key: "VITALS_OS_API_KEY", secret: true },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0].key).toBe("VITALS_OS_API_KEY");
    expect(steps[0].message).toContain("VITALS_OS_API_KEY");
  });

  it("produces the generic message for an arbitrary unknown custom secret key", () => {
    const steps = buildManualStepsChecklist([
      { key: "SOME_FUTURE_SECRET", secret: true },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0].key).toBe("SOME_FUTURE_SECRET");
    expect(steps[0].message).toContain("SOME_FUTURE_SECRET");
    expect(steps[0].message).toContain(
      "has no automated revocation — verify whether it needs to be revoked at the source.",
    );
  });
});

describe("buildManualStepsChecklist — non-secret rows", () => {
  it("produces no checklist entry for secret: false rows regardless of key name", () => {
    const steps = buildManualStepsChecklist([
      { key: "GH_TOKEN", secret: false },
      { key: "LINEAR_API_KEY", secret: false },
      { key: "SOME_RANDOM_KEY", secret: false },
    ]);
    expect(steps).toHaveLength(0);
  });
});

describe("buildManualStepsChecklist — general behavior", () => {
  it("returns an empty array for an empty envRows array", () => {
    expect(buildManualStepsChecklist([])).toEqual([]);
  });

  it("processes a mixed set of rows end-to-end", () => {
    const steps = buildManualStepsChecklist([
      { key: "GH_TOKEN", secret: true },
      { key: "ANTHROPIC_API_KEY", secret: true },
      { key: "CLAUDE_CODE_OAUTH_TOKEN", secret: true },
      { key: "SLACK_APP_ID", secret: true },
      { key: "SLACK_SIGNING_SECRET", secret: true },
      { key: "SLACK_BOT_TOKEN", secret: true },
      { key: "LINEAR_API_KEY", secret: true },
      { key: "VITALS_OS_API_KEY", secret: true },
      { key: "NON_SECRET_VALUE", secret: false },
    ]);
    const keys = steps.map((s) => s.key);
    expect(keys).toEqual([
      "GH_TOKEN",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "LINEAR_API_KEY",
      "VITALS_OS_API_KEY",
    ]);
  });

  it("preserves each entry's key on the returned ManualStep", () => {
    const steps: ManualStep[] = buildManualStepsChecklist([
      { key: "GH_TOKEN", secret: true },
    ]);
    expect(steps[0]).toMatchObject({ key: "GH_TOKEN" });
  });

  it("treats key matching as case-sensitive exact match (lowercase gh_token is treated as a generic custom secret)", () => {
    const steps = buildManualStepsChecklist([
      { key: "gh_token", secret: true },
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0].message).toContain("gh_token");
    expect(steps[0].message).not.toContain("github.com/settings/tokens");
  });

  it("produces one entry per row when the same secret key appears twice (duplicates are not deduplicated)", () => {
    const steps = buildManualStepsChecklist([
      { key: "GH_TOKEN", secret: true },
      { key: "GH_TOKEN", secret: true },
    ]);
    expect(steps).toHaveLength(2);
  });
});
