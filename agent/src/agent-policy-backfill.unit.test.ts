/**
 * agent/src/agent-policy-backfill.unit.test.ts
 *
 * Unit tests for APM-1.1's agent-policy backfill core:
 *   - parseAgentPolicyFields() against a documented-default fixture, a
 *     deliberately non-default fixture (so the parse isn't just coincidentally
 *     matching defaults), a YAML-front-matter fixture (docs/configuration.md's
 *     documented alternate syntax), and — per the task's acceptance criteria —
 *     THIS workspace's own real, live-provisioned state/agent-policy.md
 *     content, inlined verbatim below rather than re-derived.
 *   - backfillAgentPolicy()'s fake-deps round trip: the parsed fields reach
 *     updateAgentPolicy() with the right agentId, and a failing
 *     updateAgentPolicy() is caught and surfaced via `error` rather than
 *     thrown — the already-parsed `fields` are still returned so an operator
 *     can see what *would* have been written.
 *
 * Uses a fully injected updateAgentPolicy double — no real Prisma client, no
 * global.* overrides — per this repo's unit-test isolation contract.
 */

import { describe, expect, test } from "bun:test";
import {
  type AgentPolicyBackfillDeps,
  type AgentPolicyFields,
  backfillAgentPolicy,
  parseAgentPolicyFields,
} from "./agent-policy-backfill.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Matches the documented defaults exactly (docs/configuration.md's field table). */
const DEFAULT_SHAPED_CONTENT = `
### Posting
- **auto_post_reviews**: true

### Scope
- **allow_self_review**: false

### Quality Thresholds
- **min_confidence**: 75
- **max_findings**: 5

## Worktree Cleanup
- **cleanup_merged_worktrees**: true
- **cleanup_after_days**: 14
`;

/**
 * Deliberately every field flipped away from its documented default, so a
 * passing assertion can't be a coincidence of parseAgentPolicyFields()
 * secretly ignoring the file and just returning hardcoded defaults.
 */
const NON_DEFAULT_CONTENT = `
### Posting
- **auto_post_reviews**: false

### Scope
- **allow_self_review**: true

### Quality Thresholds
- **min_confidence**: 60
- **max_findings**: 12

## Worktree Cleanup
- **cleanup_merged_worktrees**: false
- **cleanup_after_days**: 30
`;

/** Mirrors docs/configuration.md's YAML-front-matter example block. */
const YAML_FRONTMATTER_CONTENT = `---
auto_post_reviews: true
allowed_events: [COMMENT, APPROVE]
review_external_prs: true
allow_self_review: false
min_confidence: 82
max_findings: 3
cleanup_merged_worktrees: false
cleanup_after_days: 21
---

# Agent Policy
`;

/**
 * Verbatim content of THIS workspace's own state/agent-policy.md — a real,
 * live-provisioned agent's actual policy file, not a synthetic fixture (AC3).
 * Bold-label syntax, one field per bullet under a heading.
 */
const REAL_WORKSPACE_POLICY_CONTENT = `# Agent Policy

This file controls the agent's autonomy level. Cron prompts reference this file --
the agent reads it at the start of every review and execute cycle.

Conservative defaults are set for safety. Relax them as trust grows.

---

## Review Policy

### Posting
- **auto_post_reviews**: true
  When true (the default), reviews are posted to GitHub automatically. When
  false, reviews are staged to \`state/reviews/\` and a Slack message is sent
  to the owner instead — the owner must explicitly approve before the review
  is posted to GitHub.

### Scope
- **review_external_prs**: true
  Review open PRs not created by this agent. Set \`auto_post_reviews: false\`
  if you'd rather stage these reviews for owner confirmation before posting.

- **allow_self_review**: false
  Review own open PRs. GitHub blocks self-APPROVE, so own PRs are always posted
  as COMMENT events. The actual verdict is recorded in the task store's
  \`PullRequest\` record for the deploy command to act on.

### Quality Thresholds
- **min_confidence**: 75
  Only surface findings with confidence score >= this value.

- **max_findings**: 5
  Maximum findings per review. Trim lowest-confidence items first.

---

## Worktree Cleanup

- **cleanup_merged_worktrees**: true
  Remove worktrees for merged PRs at the start of each cron cycle.

- **cleanup_after_days**: 14
  Remove worktrees older than this many days, even if the PR is still open.
`;

// ─── parseAgentPolicyFields ─────────────────────────────────────────────────

describe("parseAgentPolicyFields", () => {
  test("returns the documented defaults for a default-shaped file", () => {
    expect(parseAgentPolicyFields(DEFAULT_SHAPED_CONTENT)).toEqual({
      autoPostReviews: true,
      allowSelfReview: false,
      minConfidence: 75,
      maxFindings: 5,
      cleanupMergedWorktrees: true,
      cleanupAfterDays: 14,
    });
  });

  test("parses every non-default value correctly (not a default coincidence)", () => {
    expect(parseAgentPolicyFields(NON_DEFAULT_CONTENT)).toEqual({
      autoPostReviews: false,
      allowSelfReview: true,
      minConfidence: 60,
      maxFindings: 12,
      cleanupMergedWorktrees: false,
      cleanupAfterDays: 30,
    });
  });

  test("parses a YAML-front-matter-shaped file", () => {
    expect(parseAgentPolicyFields(YAML_FRONTMATTER_CONTENT)).toEqual({
      autoPostReviews: true,
      allowSelfReview: false,
      minConfidence: 82,
      maxFindings: 3,
      cleanupMergedWorktrees: false,
      cleanupAfterDays: 21,
    });
  });

  test("parses this workspace's own real, live-provisioned agent-policy.md content (AC3)", () => {
    expect(parseAgentPolicyFields(REAL_WORKSPACE_POLICY_CONTENT)).toEqual({
      autoPostReviews: true,
      allowSelfReview: false,
      minConfidence: 75,
      maxFindings: 5,
      cleanupMergedWorktrees: true,
      cleanupAfterDays: 14,
    });
  });

  test("falls back to documented defaults when every field is absent", () => {
    expect(parseAgentPolicyFields("no policy fields here")).toEqual({
      autoPostReviews: true,
      allowSelfReview: false,
      minConfidence: 75,
      maxFindings: 5,
      cleanupMergedWorktrees: true,
      cleanupAfterDays: 14,
    });
  });
});

// ─── backfillAgentPolicy ────────────────────────────────────────────────────

function makeDeps(opts: { updateError?: Error } = {}): {
  deps: AgentPolicyBackfillDeps;
  calls: Array<{ agentId: string; fields: AgentPolicyFields }>;
} {
  const calls: Array<{ agentId: string; fields: AgentPolicyFields }> = [];
  return {
    deps: {
      updateAgentPolicy: async (agentId, fields) => {
        if (opts.updateError) throw opts.updateError;
        calls.push({ agentId, fields });
      },
    },
    calls,
  };
}

describe("backfillAgentPolicy", () => {
  test("parses the file and writes the fields via updateAgentPolicy", async () => {
    const { deps, calls } = makeDeps();
    const result = await backfillAgentPolicy(
      deps,
      "agent-123",
      NON_DEFAULT_CONTENT,
    );

    expect(result.error).toBeNull();
    expect(result.agentId).toBe("agent-123");
    expect(result.fields).toEqual({
      autoPostReviews: false,
      allowSelfReview: true,
      minConfidence: 60,
      maxFindings: 12,
      cleanupMergedWorktrees: false,
      cleanupAfterDays: 30,
    });
    expect(calls).toEqual([
      {
        agentId: "agent-123",
        fields: {
          autoPostReviews: false,
          allowSelfReview: true,
          minConfidence: 60,
          maxFindings: 12,
          cleanupMergedWorktrees: false,
          cleanupAfterDays: 30,
        },
      },
    ]);
  });

  test("catches an updateAgentPolicy failure and surfaces it via error, without throwing", async () => {
    const { deps } = makeDeps({
      updateError: new Error("boom: db unreachable"),
    });
    const result = await backfillAgentPolicy(
      deps,
      "agent-456",
      DEFAULT_SHAPED_CONTENT,
    );

    expect(result.agentId).toBe("agent-456");
    expect(result.error).toBe("boom: db unreachable");
    // The already-parsed fields are still surfaced even though the write failed.
    expect(result.fields).toEqual({
      autoPostReviews: true,
      allowSelfReview: false,
      minConfidence: 75,
      maxFindings: 5,
      cleanupMergedWorktrees: true,
      cleanupAfterDays: 14,
    });
  });
});
