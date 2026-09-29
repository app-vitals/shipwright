/**
 * agent/src/agent-policy-backfill.integration.test.ts
 *
 * Integration test for APM-1.1's agent-policy backfill (AC4), against a real
 * PostgreSQL DB — mirrors admin/src/agent-patch-author-allowlist.integration.
 * test.ts's exact pattern: seed an Agent row via the real Prisma client, run
 * the backfill against a fixture markdown string with non-default values,
 * assert the DB row now has the correct 6 field values.
 *
 * Builds its own adapter-backed PrismaClient rather than importing
 * `createAdminPrismaClient` from `@shipwright/admin`: the agent Docker
 * build's module-resolution guard (`agent/Dockerfile`'s
 * `RUN find agent/src -name "*.ts" | xargs bun build ...`) bundles every
 * `.ts` file under `agent/src`, including this one, but the image only
 * copies `admin/package.json` and `admin/prisma/` into that build stage —
 * never `admin/src/` — so a VALUE import from `@shipwright/admin` (as
 * opposed to the `import type` used elsewhere in `agent/src`, which the
 * bundler elides) fails to resolve at build time. `admin/prisma/client/`
 * (the generated Prisma client) IS copied/generated in that stage, so this
 * imports it directly by relative path and duplicates
 * `admin/src/prisma-client.ts`'s small adapter-wiring (Prisma 7 needs a
 * driver adapter, not a bare `datasource.url`) rather than reaching back
 * into `admin/src`.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "../../admin/prisma/client/client.ts";
import { backfillAgentPolicy } from "./agent-policy-backfill.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  // TEST_DB is guaranteed set — the describe block is skipped otherwise.
  const pool = new pg.Pool({ connectionString: TEST_DB as string });
  const adapter = new PrismaPg(pool, { disposeExternalPool: true });
  return new PrismaClient({ adapter });
}

/** Every field flipped away from its documented default, so a passing round-trip can't be a coincidence of the DB's own column defaults. */
const NON_DEFAULT_POLICY_CONTENT = `# Agent Policy

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

describeOrSkip("backfillAgentPolicy (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.agentWorkQueueSnapshot.deleteMany();
    await prisma.agentPlugin.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agentMember.deleteMany();
    await prisma.agentPhaseMethodology.deleteMany();
    await prisma.agent.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("newly created row starts at the documented column defaults", async () => {
    const agent = await prisma.agent.create({
      data: { name: "Default Agent" },
    });
    expect(agent.autoPostReviews).toBe(true);
    expect(agent.allowSelfReview).toBe(false);
    expect(agent.minConfidence).toBe(75);
    expect(agent.maxFindings).toBe(5);
    expect(agent.cleanupMergedWorktrees).toBe(true);
    expect(agent.cleanupAfterDays).toBe(14);
  });

  it("overwrites an agent's row with its policy file's real, non-default values", async () => {
    const agent = await prisma.agent.create({
      data: { name: "Backfill Agent" },
    });

    const result = await backfillAgentPolicy(
      {
        updateAgentPolicy: (agentId, fields) =>
          prisma.agent
            .update({ where: { id: agentId }, data: fields })
            .then(() => {}),
      },
      agent.id,
      NON_DEFAULT_POLICY_CONTENT,
    );

    expect(result.error).toBeNull();
    expect(result.fields).toEqual({
      autoPostReviews: false,
      allowSelfReview: true,
      minConfidence: 60,
      maxFindings: 12,
      cleanupMergedWorktrees: false,
      cleanupAfterDays: 30,
    });

    const updated = await prisma.agent.findUniqueOrThrow({
      where: { id: agent.id },
    });
    expect(updated.autoPostReviews).toBe(false);
    expect(updated.allowSelfReview).toBe(true);
    expect(updated.minConfidence).toBe(60);
    expect(updated.maxFindings).toBe(12);
    expect(updated.cleanupMergedWorktrees).toBe(false);
    expect(updated.cleanupAfterDays).toBe(30);
  });

  it("surfaces a non-existent agent id as a per-agent error rather than throwing", async () => {
    const result = await backfillAgentPolicy(
      {
        updateAgentPolicy: (agentId, fields) =>
          prisma.agent
            .update({ where: { id: agentId }, data: fields })
            .then(() => {}),
      },
      "does-not-exist",
      NON_DEFAULT_POLICY_CONTENT,
    );

    expect(result.error).not.toBeNull();
    expect(result.fields.minConfidence).toBe(60); // parsed fields still surfaced
  });
});
