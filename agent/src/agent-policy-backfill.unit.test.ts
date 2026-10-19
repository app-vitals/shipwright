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
  parseAllowSelfReview,
  parseAutoPostReviews,
  parseCleanupAfterDays,
  parseCleanupMergedWorktrees,
  parseMaxFindings,
  parseMinConfidence,
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

// ─── Policy parsers (relocated from check-helpers.unit.test.ts, ARD-1.1) ───

describe("parseAllowSelfReview", () => {
  test("returns true when the table cell says true", () => {
    expect(parseAllowSelfReview("| `allow_self_review` | true |")).toBe(true);
  });

  test("returns false when the table cell says false", () => {
    expect(parseAllowSelfReview("| `allow_self_review` | false |")).toBe(false);
  });

  test("returns false for bold-style false", () => {
    expect(parseAllowSelfReview("**allow_self_review**: false")).toBe(false);
  });

  test("returns true for bold-style true", () => {
    expect(parseAllowSelfReview("**allow_self_review**: true")).toBe(true);
  });

  test("returns true for plain YAML frontmatter style true", () => {
    expect(
      parseAllowSelfReview(
        "---\nauto_post_reviews: true\nallow_self_review: true\nmin_confidence: 75\n---\n",
      ),
    ).toBe(true);
  });

  test("returns false for plain YAML frontmatter style false", () => {
    expect(
      parseAllowSelfReview(
        "---\nauto_post_reviews: true\nallow_self_review: false\nmin_confidence: 75\n---\n",
      ),
    ).toBe(false);
  });

  test("defaults to false when the field is missing entirely", () => {
    expect(parseAllowSelfReview("no policy here")).toBe(false);
  });
});

describe("parseCleanupMergedWorktrees", () => {
  test("returns true when the table cell says true", () => {
    expect(
      parseCleanupMergedWorktrees("| `cleanup_merged_worktrees` | true |"),
    ).toBe(true);
  });

  test("returns false when the table cell says false", () => {
    expect(
      parseCleanupMergedWorktrees("| `cleanup_merged_worktrees` | false |"),
    ).toBe(false);
  });

  test("returns false for bold-style false", () => {
    expect(
      parseCleanupMergedWorktrees("**cleanup_merged_worktrees**: false"),
    ).toBe(false);
  });

  test("returns true for bold-style true", () => {
    expect(
      parseCleanupMergedWorktrees("**cleanup_merged_worktrees**: true"),
    ).toBe(true);
  });

  test("returns false for plain YAML frontmatter style false", () => {
    expect(
      parseCleanupMergedWorktrees(
        "---\ncleanup_merged_worktrees: false\ncleanup_after_days: 14\n---\n",
      ),
    ).toBe(false);
  });

  test("returns true for plain YAML frontmatter style true", () => {
    expect(
      parseCleanupMergedWorktrees(
        "---\ncleanup_merged_worktrees: true\ncleanup_after_days: 14\n---\n",
      ),
    ).toBe(true);
  });

  test("defaults to true when the field is missing entirely", () => {
    expect(parseCleanupMergedWorktrees("no policy here")).toBe(true);
  });

  test("defaults to true when content is empty", () => {
    expect(parseCleanupMergedWorktrees("")).toBe(true);
  });
});

describe("parseCleanupAfterDays", () => {
  test("parses numeric value from table format", () => {
    expect(parseCleanupAfterDays("| `cleanup_after_days` | 7 |")).toBe(7);
  });

  test("parses numeric value from bold-style format", () => {
    expect(parseCleanupAfterDays("**cleanup_after_days**: 21")).toBe(21);
  });

  test("parses numeric value from plain YAML frontmatter style", () => {
    expect(
      parseCleanupAfterDays(
        "---\ncleanup_merged_worktrees: true\ncleanup_after_days: 30\n---\n",
      ),
    ).toBe(30);
  });

  test("defaults to 14 when the field is missing", () => {
    expect(parseCleanupAfterDays("no policy here")).toBe(14);
  });

  test("defaults to 14 when content is empty", () => {
    expect(parseCleanupAfterDays("")).toBe(14);
  });

  test("handles leading/trailing whitespace around numeric value", () => {
    expect(parseCleanupAfterDays("**cleanup_after_days**:   30   ")).toBe(30);
  });

  test("defaults to 14 when value is not a valid number", () => {
    expect(parseCleanupAfterDays("**cleanup_after_days**: abc")).toBe(14);
  });

  test("defaults to 14 when parsed value is NaN", () => {
    expect(parseCleanupAfterDays("**cleanup_after_days**: NaN")).toBe(14);
  });

  test("parses zero as a valid value", () => {
    expect(parseCleanupAfterDays("**cleanup_after_days**: 0")).toBe(0);
  });
});

describe("parseAutoPostReviews", () => {
  test("returns true when the table cell says true", () => {
    expect(parseAutoPostReviews("| `auto_post_reviews` | true |")).toBe(true);
  });

  test("returns false when the table cell says false", () => {
    expect(parseAutoPostReviews("| `auto_post_reviews` | false |")).toBe(false);
  });

  test("returns false for bold-style false", () => {
    expect(parseAutoPostReviews("**auto_post_reviews**: false")).toBe(false);
  });

  test("returns true for bold-style true", () => {
    expect(parseAutoPostReviews("**auto_post_reviews**: true")).toBe(true);
  });

  test("returns false for plain YAML frontmatter style false", () => {
    expect(
      parseAutoPostReviews(
        "---\nauto_post_reviews: false\nallow_self_review: false\n---\n",
      ),
    ).toBe(false);
  });

  test("returns true for plain YAML frontmatter style true", () => {
    expect(
      parseAutoPostReviews(
        "---\nauto_post_reviews: true\nallow_self_review: false\n---\n",
      ),
    ).toBe(true);
  });

  test("defaults to true when the field is missing entirely", () => {
    expect(parseAutoPostReviews("no policy here")).toBe(true);
  });

  test("defaults to true when content is empty", () => {
    expect(parseAutoPostReviews("")).toBe(true);
  });
});

describe("parseMinConfidence", () => {
  test("parses numeric value from table format", () => {
    expect(parseMinConfidence("| `min_confidence` | 60 |")).toBe(60);
  });

  test("parses numeric value from bold-style format", () => {
    expect(parseMinConfidence("**min_confidence**: 90")).toBe(90);
  });

  test("parses numeric value from plain YAML frontmatter style", () => {
    expect(
      parseMinConfidence(
        "---\nauto_post_reviews: true\nmin_confidence: 80\n---\n",
      ),
    ).toBe(80);
  });

  test("defaults to 75 when the field is missing", () => {
    expect(parseMinConfidence("no policy here")).toBe(75);
  });

  test("defaults to 75 when content is empty", () => {
    expect(parseMinConfidence("")).toBe(75);
  });

  test("handles leading/trailing whitespace around numeric value", () => {
    expect(parseMinConfidence("**min_confidence**:   80   ")).toBe(80);
  });

  test("defaults to 75 when value is not a valid number", () => {
    expect(parseMinConfidence("**min_confidence**: abc")).toBe(75);
  });

  test("parses zero as a valid value", () => {
    expect(parseMinConfidence("**min_confidence**: 0")).toBe(0);
  });
});

describe("parseMaxFindings", () => {
  test("parses numeric value from table format", () => {
    expect(parseMaxFindings("| `max_findings` | 3 |")).toBe(3);
  });

  test("parses numeric value from bold-style format", () => {
    expect(parseMaxFindings("**max_findings**: 10")).toBe(10);
  });

  test("parses numeric value from plain YAML frontmatter style", () => {
    expect(
      parseMaxFindings("---\nmin_confidence: 75\nmax_findings: 8\n---\n"),
    ).toBe(8);
  });

  test("defaults to 5 when the field is missing", () => {
    expect(parseMaxFindings("no policy here")).toBe(5);
  });

  test("defaults to 5 when content is empty", () => {
    expect(parseMaxFindings("")).toBe(5);
  });

  test("handles leading/trailing whitespace around numeric value", () => {
    expect(parseMaxFindings("**max_findings**:   8   ")).toBe(8);
  });

  test("defaults to 5 when value is not a valid number", () => {
    expect(parseMaxFindings("**max_findings**: abc")).toBe(5);
  });

  test("parses zero as a valid value", () => {
    expect(parseMaxFindings("**max_findings**: 0")).toBe(0);
  });
});
