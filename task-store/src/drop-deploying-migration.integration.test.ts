/**
 * task-store/src/drop-deploying-migration.integration.test.ts
 *
 * MPD-3.5 integration coverage for the
 * 20261108000000_drop_deploying_status_deploy_phase migration.
 *
 * The migration removes `deploying` from TaskStatus, `deploy` from PrPhase and
 * the `Task.deployingAt` / `PullRequest.readyForDeployAt` columns. Postgres
 * cannot DROP an enum value, so the migration recreates both enums — which
 * means the pre-migration shape cannot be re-created inside the shared
 * `public` schema without breaking sibling suites. Instead, each test builds a
 * throwaway schema, replays every migration that precedes this one into it
 * (so it holds the exact pre-MPD-3.5 shape), seeds rows that use the dropped
 * values, applies the real migration.sql, and asserts the result. The scratch
 * schema is dropped afterwards.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST; the suite skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { toPoolConfig } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const MIGRATIONS_DIR = join(import.meta.dir, "..", "prisma", "migrations");
const TARGET = "20261108000000_drop_deploying_status_deploy_phase";

function migrationSql(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
}

/** Every migration directory that sorts before TARGET, in apply order. */
function priorMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name < TARGET)
    .map((d) => d.name)
    .sort();
}

describeOrSkip(
  "drop deploying/deploy-phase migration (MPD-3.5, integration)",
  () => {
    let client: pg.Client;
    let schema: string;

    beforeEach(async () => {
      schema = `mpd35_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      // TEST_DB is guaranteed set — the describe block is skipped otherwise.
      client = new pg.Client(toPoolConfig(TEST_DB as string));
      await client.connect();
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      for (const name of priorMigrations()) {
        await client.query(migrationSql(name));
      }
    });

    afterEach(async () => {
      // A failed migration leaves the session inside its aborted BEGIN block,
      // where the DROP below would be refused — and a leaked scratch schema
      // pollutes sibling suites that inspect pg_indexes database-wide.
      await client.query("ROLLBACK");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    });

    async function applyTarget(): Promise<void> {
      await client.query(migrationSql(TARGET));
    }

    async function enumValues(type: string): Promise<string[]> {
      const { rows } = await client.query<{ v: string }>(
        `SELECT e.enumlabel AS v
         FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = $1 AND n.nspname = $2
        ORDER BY e.enumsortorder`,
        [type, schema],
      );
      return rows.map((r) => r.v);
    }

    async function columnExists(
      table: string,
      column: string,
    ): Promise<boolean> {
      const { rowCount } = await client.query(
        `SELECT 1 FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        [schema, table, column],
      );
      return (rowCount ?? 0) > 0;
    }

    async function seed(): Promise<void> {
      await client.query(
        `INSERT INTO "Task" ("id","title","status","deployingAt","updatedAt") VALUES
         ('t-deploying-1', 'mid-deploy 1', 'deploying', '2026-07-01T00:00:00.000Z', now()),
         ('t-deploying-2', 'mid-deploy 2', 'deploying', NULL, now()),
         ('t-deployed',    'live',         'deployed',  '2026-07-01T00:00:00.000Z', now()),
         ('t-pending',     'queued',       'pending',   NULL, now());`,
      );
      await client.query(
        `INSERT INTO "PullRequest"
         ("id","repo","prNumber","state","phase","claimedBy","claimedAt","heartbeatAt",
          "readyForReviewAt","readyForMergeAt","readyForDeployAt","updatedAt") VALUES
         ('pr-deploy-claimed', 'o/r', 1, 'open', 'deploy', 'agent-a',
          '2026-07-01T01:00:00.000Z', '2026-07-01T01:05:00.000Z',
          NULL, NULL, '2026-07-01T01:00:00.000Z', now()),
         ('pr-deploy-stale', 'o/r', 2, 'open', 'deploy', NULL, NULL, NULL,
          NULL, NULL, '2026-07-01T02:00:00.000Z', now()),
         ('pr-review-claimed', 'o/r', 3, 'open', 'review', 'agent-b',
          '2026-07-01T03:00:00.000Z', '2026-07-01T03:05:00.000Z',
          '2026-07-01T03:00:00.000Z', NULL, NULL, now()),
         ('pr-both-ready', 'o/r', 4, 'merged', NULL, NULL, NULL, NULL,
          NULL, '2026-07-02T00:00:00.000Z', '2026-07-01T04:00:00.000Z', now());`,
      );
    }

    it("removes deploying from TaskStatus and deploy from PrPhase", async () => {
      await seed();
      await applyTarget();

      expect(await enumValues("TaskStatus")).toEqual([
        "pending",
        "in_progress",
        "pr_open",
        "approved",
        "merged",
        "done",
        "deployed",
        "released",
        "blocked",
        "cancelled",
      ]);
      expect(await enumValues("PrPhase")).toEqual(["review", "patch", "merge"]);
      expect(await columnExists("Task", "deployingAt")).toBe(false);
      expect(await columnExists("PullRequest", "readyForDeployAt")).toBe(false);
    });

    it("maps every deploying task to merged and leaves other statuses alone", async () => {
      await seed();
      await applyTarget();

      const { rows } = await client.query<{ id: string; status: string }>(
        `SELECT "id", "status"::text AS status FROM "Task" ORDER BY "id"`,
      );
      expect(rows).toEqual([
        { id: "t-deployed", status: "deployed" },
        { id: "t-deploying-1", status: "merged" },
        { id: "t-deploying-2", status: "merged" },
        { id: "t-pending", status: "pending" },
      ]);
    });

    it("clears deploy-phase claims, keeps other claims, and backfills readyForMergeAt", async () => {
      await seed();
      await applyTarget();

      const { rows } = await client.query(
        `SELECT "id", "phase"::text AS phase, "claimedBy", "claimedAt", "heartbeatAt", "readyForMergeAt"
         FROM "PullRequest" ORDER BY "id"`,
      );
      expect(rows).toEqual([
        {
          id: "pr-both-ready",
          phase: null,
          claimedBy: null,
          claimedAt: null,
          heartbeatAt: null,
          // already set — not overwritten by readyForDeployAt
          readyForMergeAt: "2026-07-02T00:00:00.000Z",
        },
        {
          id: "pr-deploy-claimed",
          phase: null,
          claimedBy: null,
          claimedAt: null,
          heartbeatAt: null,
          readyForMergeAt: "2026-07-01T01:00:00.000Z",
        },
        {
          id: "pr-deploy-stale",
          phase: null,
          claimedBy: null,
          claimedAt: null,
          heartbeatAt: null,
          readyForMergeAt: "2026-07-01T02:00:00.000Z",
        },
        {
          id: "pr-review-claimed",
          phase: "review",
          claimedBy: "agent-b",
          claimedAt: "2026-07-01T03:00:00.000Z",
          heartbeatAt: "2026-07-01T03:05:00.000Z",
          readyForMergeAt: null,
        },
      ]);
    });

    it("keeps the pending/claimedBy CHECK constraint enforced after the enum swap", async () => {
      await applyTarget();

      await expect(
        client.query(
          `INSERT INTO "Task" ("id","title","status","claimedBy","updatedAt")
         VALUES ('t-bad', 'bad', 'pending', 'agent-x', now())`,
        ),
      ).rejects.toThrow(/task_pending_claimed_by_invariant/);
    });

    it("rejects the dropped enum values after the migration", async () => {
      await applyTarget();

      await expect(
        client.query(
          `INSERT INTO "Task" ("id","title","status","updatedAt")
         VALUES ('t-x', 'x', 'deploying', now())`,
        ),
      ).rejects.toThrow(/invalid input value for enum/);
      await expect(
        client.query(
          `INSERT INTO "PullRequest" ("id","repo","prNumber","state","phase","updatedAt")
         VALUES ('pr-x', 'o/r', 9, 'open', 'deploy', now())`,
        ),
      ).rejects.toThrow(/invalid input value for enum/);
    });

    it("applies cleanly to an empty database", async () => {
      await applyTarget();
      expect(await enumValues("PrPhase")).toEqual(["review", "patch", "merge"]);
    });
  },
);
