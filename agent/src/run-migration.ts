import { HttpAccountsMigrationClient } from "./accounts-migration-client.ts";
import { HttpShipwrightAdminClient } from "./shipwright-admin-client.ts";
import { runMigration } from "./migrate.ts";

const REQUIRED_VARS = [
  "VITALS_OS_API_URL",
  "VITALS_OS_API_KEY",
  "SHIPWRIGHT_API_URL",
  "SHIPWRIGHT_ADMIN_API_KEY",
  "SHIPWRIGHT_INTERNAL_API_KEY",
] as const;

for (const varName of REQUIRED_VARS) {
  if (!process.env[varName]) {
    console.error(`Missing required env var: ${varName}`);
    process.exit(1);
  }
}

const accountsClient = new HttpAccountsMigrationClient(
  process.env.VITALS_OS_API_URL as string,
  process.env.VITALS_OS_API_KEY as string,
);

const adminClient = new HttpShipwrightAdminClient(
  process.env.SHIPWRIGHT_API_URL as string,
  process.env.SHIPWRIGHT_ADMIN_API_KEY as string,
  process.env.SHIPWRIGHT_INTERNAL_API_KEY as string,
);

const result = await runMigration(accountsClient, adminClient);

console.log(`Migration complete: ${result.migrated} agent(s) migrated`);

if (result.failed.length > 0) {
  console.error("Failed agents:");
  for (const failure of result.failed) {
    console.error(`  ${failure.agentId} [${failure.field}]: ${failure.error}`);
  }
  process.exit(1);
}
