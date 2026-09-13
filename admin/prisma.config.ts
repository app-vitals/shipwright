/**
 * admin/prisma.config.ts
 *
 * Prisma 7 CLI configuration for the admin service.
 *
 * Prisma 7 removed `url` from the `datasource` block in schema.prisma, so the
 * connection string used by CLI commands (`prisma migrate deploy|dev`,
 * `prisma db ...`) is declared here instead. The *runtime* client does not read
 * this file at all — it connects through a `PrismaPg` driver adapter built in
 * admin/src/prisma-client.ts.
 *
 * `datasource.url` is read straight off `process.env` rather than Prisma's
 * `env()` helper on purpose: `env()` throws when the variable is unset, which
 * would break `prisma generate` (run in `postinstall` and in admin/Dockerfile)
 * in environments that legitimately have no database — generate needs the
 * schema, not a connection. Leaving it `undefined` defers the failure to the
 * commands that actually need a URL, which report it themselves.
 *
 * Paths are relative to this file (admin/), matching the existing
 * `--schema=prisma/schema.prisma` invocations in package.json, Taskfile.yml,
 * admin/Dockerfile, scripts/hitl.ts, and scripts/dev-tmux.ts.
 */

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL_SHIPWRIGHT_ADMIN,
  },
});
