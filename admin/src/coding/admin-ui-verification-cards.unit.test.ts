/**
 * admin/src/coding/admin-ui-verification-cards.unit.test.ts
 * Pure unit tests for the agent detail page's "Recent Verification Activity"
 * card, rendered through the page's header card slot (relocated from
 * admin-ui-pages.unit.test.ts, AEP-3.2).
 */

import { describe, expect, test } from "bun:test";
import {
  type AgentDetail,
  renderAgentDetailPage,
} from "@app-vitals/agent-admin/admin-ui-pages";
import {
  renderVerificationActivityCard,
  type VerificationActivitySummary,
} from "./admin-ui-verification-cards.ts";

const USER_NAME = "alice";

const AGENT: AgentDetail = {
  id: "agent-123",
  name: "Test Agent",
  slackId: "U12345",
  selfHosted: false,
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-02T00:00:00Z"),
  repos: [],
  authorAllowlist: [],
  patchAuthorAllowlist: [],
  restrictSlackToMembers: false,
  specialty: "coding",
  missingRequiredEnv: [],
  autoPostReviews: true,
  allowSelfReview: false,
  minConfidence: 75,
  maxFindings: 5,
  cleanupMergedWorktrees: true,
  cleanupAfterDays: 14,
};

describe("renderAgentDetailPage — Recent Verification Activity rollup", () => {
  function render(verificationActivity?: VerificationActivitySummary): string {
    return renderAgentDetailPage(
      AGENT,
      {},
      [],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      {
        timezone: "UTC",
        extensionCardsHtml: [
          renderVerificationActivityCard(verificationActivity),
        ],
      },
    );
  }

  test("no rollup card when verificationActivity is absent", () => {
    const html = render(undefined);
    expect(html).not.toContain("Recent Verification Activity");
  });

  test("renders rollup card with heading when verificationActivity is present", () => {
    const html = render({
      totalChecks: 12,
      itemCount: 3,
      counts: { ran_passed: 9, ran_failed: 2, skipped: 1 },
    });
    expect(html).toContain("Recent Verification Activity");
  });

  test("renders counts by status", () => {
    const html = render({
      totalChecks: 12,
      itemCount: 3,
      counts: { ran_passed: 9, ran_failed: 2, skipped: 1 },
    });
    expect(html).toContain("9");
    expect(html).toContain("passed");
    expect(html).toContain("2");
    expect(html).toContain("failed");
    expect(html).toContain("1");
    expect(html).toContain("skipped");
  });

  test("renders empty-state message when totalChecks is 0", () => {
    const html = render({ totalChecks: 0, itemCount: 0, counts: {} });
    expect(html).toContain("Recent Verification Activity");
    expect(html).toContain("No recent verification checks recorded");
  });

  test("renders per-checkName rows with their own status badges", () => {
    const html = render({
      totalChecks: 12,
      itemCount: 3,
      counts: { ran_passed: 9, ran_failed: 2, skipped: 1 },
      byCheckName: {
        unit: { ran_passed: 9 },
        lint: { ran_passed: 2, ran_failed: 1 },
      },
    });
    // Check-name labels present.
    expect(html).toContain("unit");
    expect(html).toContain("lint");
    // The "passed" label appears once for the aggregate line, once for the
    // "unit" row, and once for the "lint" row (3 total); "failed" appears
    // once for the aggregate line and once for the "lint" row (2 total).
    expect(html.split("passed").length - 1).toBe(3);
    expect(html.split("failed").length - 1).toBe(2);
  });

  test("renders per-repo status breakdown when byRepo spans multiple repos", () => {
    const html = render({
      totalChecks: 6,
      itemCount: 2,
      counts: { ran_passed: 4, skipped: 2 },
      byRepo: {
        "acme/widgets": { ran_passed: 3, skipped: 1 },
        "acme/gadgets": { ran_passed: 1, skipped: 1 },
      },
    });
    expect(html).toContain("acme/widgets");
    expect(html).toContain("acme/gadgets");
  });

  test("omits per-repo breakdown when byRepo spans only one repo", () => {
    const html = render({
      totalChecks: 4,
      itemCount: 1,
      counts: { ran_passed: 4 },
      byRepo: { "acme/widgets": { ran_passed: 4 } },
    });
    expect(html).not.toContain("acme/widgets");
  });

  test("omits per-repo breakdown when byRepo is absent", () => {
    const html = render({
      totalChecks: 4,
      itemCount: 1,
      counts: { ran_passed: 4 },
    });
    // No repo breakdown section should render at all without exploding.
    expect(html).toContain("Recent Verification Activity");
  });

  test("renders Environmental issues section with human-readable reasonCategory labels", () => {
    const html = render({
      totalChecks: 5,
      itemCount: 2,
      counts: { skipped: 3, timed_out: 2 },
      environmentalByRepo: {
        "acme/widgets": { missing_tool: 2, missing_secret: 1 },
        "acme/gadgets": { check_timeout: 2 },
      },
    });
    expect(html).toContain("Environmental issues");
    expect(html).toContain("missing tool");
    expect(html).toContain("missing secret");
    expect(html).toContain("check timed out");
    expect(html).not.toContain("No environmental issues in recent runs");
  });

  test("renders an explicit all-clear message when environmentalByRepo is empty", () => {
    const html = render({
      totalChecks: 4,
      itemCount: 1,
      counts: { ran_passed: 4 },
      environmentalByRepo: {},
    });
    expect(html).toContain("Environmental issues");
    expect(html).toContain("No environmental issues in recent runs");
  });

  test("renders an explicit all-clear message when environmentalByRepo entries are all-zero", () => {
    const html = render({
      totalChecks: 4,
      itemCount: 1,
      counts: { ran_passed: 4 },
      environmentalByRepo: { "acme/widgets": { missing_tool: 0 } },
    });
    expect(html).toContain("No environmental issues in recent runs");
  });

  test("renders an explicit all-clear message when environmentalByRepo is absent", () => {
    const html = render({
      totalChecks: 4,
      itemCount: 1,
      counts: { ran_passed: 4 },
    });
    expect(html).toContain("No environmental issues in recent runs");
  });
});
