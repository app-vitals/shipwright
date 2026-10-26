/**
 * admin/src/platform-migrations.unit.test.ts
 *
 * AGR-4.2: the admin's Prisma schema and its single migration history come
 * from @app-vitals/agent-admin. Pins that history against the one Shipwright
 * shipped before the swap: every pre-swap migration is present byte-for-byte
 * (sha256 of migration.sql), and the only additions are the pinned package's
 * own new migrations. A platform bump that edits an applied migration, drops
 * one, or adds a migration not listed here fails, so each schema change is
 * reviewed on its way into Shipwright's deployment.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const PACKAGE_DIR = dirname(
  Bun.resolveSync("@app-vitals/agent-admin/package.json", import.meta.dir),
);
const MIGRATIONS_DIR = join(PACKAGE_DIR, "prisma", "migrations");

/** Shipwright's migration history before AGR-4.2: name, sha256 prefix. */
const PRE_SWAP: ReadonlyArray<readonly [string, string]> = [
  ["20260608000000_init", "9d655d7b1e3fc57d"],
  ["20260616000000_agent_members", "1013d7ab736d23ed"],
  ["20260624000000_add_agent_self_hosted", "73709d4a229fd2b3"],
  ["20260624120000_add_agent_repos", "1c86234ead017a96"],
  ["20260625000000_add_agent_cron_run", "a0f113f0ec193ff2"],
  ["20260626000000_add_cron_run_token_fields", "632205d8c75dcc8c"],
  ["20260627000000_add_agent_chat_token_usage_daily", "4a0a56b7cef1d972"],
  ["20260627010000_add_agent_chat_token_usage_fk", "e678bd855d9f4abe"],
  ["20260701000000_add_chat_threads_messages", "eca715440f4dbe9a"],
  ["20260701010000_drop_chat_threads_messages", "b99b85e1a33a5cfc"],
  ["20260701020000_add_cron_run_model_breakdown", "803ccceb0467de73"],
  ["20260701020000_chat_token_by_model", "f9d5724c1f38d144"],
  ["20260701030000_add_secret_flag_to_agent_env", "838506de2137eb2e"],
  ["20260701030000_drop_cron_run_legacy_columns", "dc788b02dae67d82"],
  ["20260706000000_consolidate_cron_run_token_accounting", "b05a9981ea7cc4dd"],
  ["20260709000000_add_phase_to_agent_cron_run", "b8b4a9c37dcc21fa"],
  ["20260717000000_add_item_tracking_to_agent_cron_run", "aeb0b04ccd8d0935"],
  ["20260717010000_add_agent_work_queue_snapshot", "609d097b18860763"],
  ["20260718000000_add_cron_phase_columns", "d42aaa9e2a09a726"],
  ["20260718100000_drop_agent_cron_run_phase_column", "a5bfce33478413da"],
  ["20260724000000_add_agent_type_name", "e92c26fc031bc8ab"],
  ["20260725232433_add_agent_author_allowlist", "9271385b8d4924ea"],
  ["20260727120000_add_not_null_to_agent_author_allowlist", "5f2781537d96173c"],
  ["20260731000000_add_session_id_to_agent_cron_run", "a429565dd29a30bc"],
  ["20260821000000_add_agent_restrict_slack_to_members", "93d68204f126533d"],
  [
    "20260901000000_add_push_subscription_and_chat_thread_watch",
    "e3ca8e0b9e54f10d",
  ],
  ["20260903000000_add_agent_patch_author_allowlist", "7f23327a47eadf86"],
  ["20260903120000_add_agent_review_author_allowlist", "3ca2805e41104d9b"],
  ["20260903150000_drop_agent_author_allowlist", "db9b1fa64869dd3d"],
  ["20260905000000_add_started_at_index_to_agent_cron_run", "f73fe41d9011d68a"],
  [
    "20260906000000_add_session_follow_notification_prefs_alert_state",
    "3b2c46fc8fad1e34",
  ],
  ["20260911000000_backfill_auto_follow_since", "9d9ed83f6faa1bd6"],
  [
    "20260923115814_add_last_heartbeat_at_to_agent_cron_run",
    "d2df799289dde405",
  ],
  ["20260924120000_add_trial_expiry_fields_to_agent", "184e21f1c81cd9e7"],
  ["20260929000000_add_agent_phase_methodology", "c56d10bc3745830e"],
  ["20260929120000_add_agent_policy_fields", "9808db9552413ea3"],
  [
    "20261005000000_add_agent_github_installations_snapshot",
    "b0dc111f5b79aa9d",
  ],
  ["20261008000000_add_cron_run_telemetry", "549540777de6e308"],
  ["20261008010000_add_account_models", "4551215876d42de6"],
  ["20261008020000_add_cron_lockdown_disabled_at", "89eb9da6355042c4"],
  ["20261009000000_chat_token_usage_bigint", "7c17352439caf172"],
  ["20261010000000_add_cron_run_command_variant", "4a0aa96cc4e2fedd"],
  ["20261019000000_add_agent_anthropic_identity", "f40c0ce269d823e1"],
];

/** The migrations @app-vitals/agent-admin 0.5.0 adds; all additive. */
const PLATFORM_ADDITIONS: ReadonlyArray<readonly [string, string]> = [
  ["20261025000000_add_agent_ask", "c13175f9380b563b"],
  ["20261026000000_add_agent_pod_service_account", "d7cf68fd3e0bf309"],
  ["20261027000000_add_cron_run_transcripts", "e9f3d67804d4a2f1"],
  ["20261028000000_add_cron_run_now", "986fc3f8f369c5cb"],
  [
    "20261028000000_add_repo_access_to_github_installations_snapshot",
    "3794b3483416fa04",
  ],
];

function hashOf(name: string): string {
  return createHash("sha256")
    .update(readFileSync(join(MIGRATIONS_DIR, name, "migration.sql")))
    .digest("hex")
    .slice(0, 16);
}

const shipped = readdirSync(MIGRATIONS_DIR)
  .filter((name) => statSync(join(MIGRATIONS_DIR, name)).isDirectory())
  .sort();

describe("admin migration history (AGR-4.2)", () => {
  it("pins @app-vitals/agent-admin 0.5.0", () => {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_DIR, "package.json"), "utf8"),
    ) as { version: string };
    expect(pkg.version).toBe("0.5.0");
  });

  it("is exactly the pre-swap history plus the pinned platform additions", () => {
    expect(shipped).toEqual(
      [...PRE_SWAP, ...PLATFORM_ADDITIONS].map(([name]) => name).sort(),
    );
  });

  it("leaves every pre-swap migration byte-for-byte unchanged", () => {
    for (const [name, sha] of PRE_SWAP) {
      expect(hashOf(name), name).toBe(sha);
    }
  });

  it("platform additions match the reviewed SQL", () => {
    for (const [name, sha] of PLATFORM_ADDITIONS) {
      expect(hashOf(name), name).toBe(sha);
    }
  });

  it("platform additions are additive: no DROP/RENAME, no data change, no NOT NULL column on an existing table", () => {
    for (const [name] of PLATFORM_ADDITIONS) {
      const statements = readFileSync(
        join(MIGRATIONS_DIR, name, "migration.sql"),
        "utf8",
      )
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const statement of statements) {
        expect(statement, name).toMatch(
          /^(CREATE TABLE|CREATE (UNIQUE )?INDEX|ALTER TABLE "\w+" ADD COLUMN)/,
        );
        expect(statement, name).not.toMatch(
          /\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME)\b/i,
        );
        if (statement.startsWith("ALTER TABLE")) {
          for (const column of statement.split(/,\s*ADD COLUMN/)) {
            if (/NOT NULL/.test(column)) {
              expect(column, name).toMatch(/DEFAULT/);
            }
          }
        }
      }
    }
  });
});
