/**
 * admin/prisma.config.ts
 *
 * Prisma 7 CLI configuration for Shipwright's admin database.
 *
 * The schema and the single migration history are the platform's: they ship
 * in @app-vitals/agent-admin (AGR-4.2), so this config points the CLI at the
 * installed package rather than at a local prisma/ directory. Shipwright adds
 * no schema or migrations of its own.
 *
 * The *runtime* client does not read this file — it connects through a
 * `PrismaPg` driver adapter built in @app-vitals/agent-admin/prisma-client, and
 * startAdmin() runs `prisma migrate deploy` against the package's own config.
 * This file serves the local CLI entrypoints (`task db:provision`,
 * scripts/hitl.ts, scripts/dev-tmux.ts), all of which run
 * `bunx prisma ...` from admin/ with no `--schema` flag.
 *
 * `datasource.url` is read straight off `process.env` rather than Prisma's
 * `env()` helper on purpose: `env()` throws when the variable is unset, which
 * would break commands that need the schema but no database. Leaving it
 * `undefined` defers the failure to the commands that actually need a URL,
 * which report it themselves.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "prisma/config";

const PLATFORM_ADMIN_DIR = dirname(
  createRequire(import.meta.url).resolve(
    "@app-vitals/agent-admin/package.json",
  ),
);

export default defineConfig({
  schema: join(PLATFORM_ADMIN_DIR, "prisma", "schema"),
  migrations: {
    path: join(PLATFORM_ADMIN_DIR, "prisma", "migrations"),
  },
  datasource: {
    url: process.env.DATABASE_URL_SHIPWRIGHT_ADMIN,
  },
});
