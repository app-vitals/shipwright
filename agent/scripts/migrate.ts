/**
 * agent/scripts/migrate.ts
 * CLI entry point for the data migration script.
 *
 * Reads env vars:
 *   VITALS_OS_API_URL       — base URL of the vitals-os accounts API
 *   VITALS_OS_API_KEY       — bearer token for the accounts API
 *   SHIPWRIGHT_ADMIN_URL    — base URL of the shipwright admin API
 *   SHIPWRIGHT_ADMIN_API_KEY — bearer API key for the shipwright admin API
 *
 * Exits 0 on full success, non-zero if any agent migration failed.
 * Reports failing agent IDs and fields to stderr.
 */

import { HttpAccountsMigrationClient } from "../src/accounts-migration-client.ts";
import { runMigration } from "../src/migrate.ts";
import { HttpShipwrightAdminClient } from "../src/shipwright-admin-client.ts";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Error: required environment variable ${name} is not set`);
    process.exit(1);
  }
  return val;
}

const vitalsOsApiUrl = requireEnv("VITALS_OS_API_URL");
const vitalsOsApiKey = requireEnv("VITALS_OS_API_KEY");
const shipwrightAdminUrl = requireEnv("SHIPWRIGHT_ADMIN_URL");
const shipwrightAdminApiKey = requireEnv("SHIPWRIGHT_ADMIN_API_KEY");

const accountsClient = new HttpAccountsMigrationClient(
  vitalsOsApiUrl,
  vitalsOsApiKey,
);
const adminClient = new HttpShipwrightAdminClient(
  shipwrightAdminUrl,
  shipwrightAdminApiKey,
);

console.log("Starting data migration...");

const result = await runMigration(accountsClient, adminClient);

console.log(`Migration complete: ${result.migrated} agent(s) migrated.`);

if (result.failed.length > 0) {
  console.error(`\n${result.failed.length} failure(s):`);
  for (const failure of result.failed) {
    console.error(
      `  agent=${failure.agentId} field=${failure.field}: ${failure.error}`,
    );
  }
  process.exit(1);
}
