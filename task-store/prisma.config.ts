/**
 * task-store/prisma.config.ts
 *
 * Prisma CLI configuration for the task-store service.
 *
 * Prisma 7 moved two things out of `prisma/schema.prisma` and into this file:
 *   - schema/migrations *location* (previously passed as `--schema=` on every
 *     CLI invocation), and
 *   - the Migrate connection URL (`datasource.url`), which v7 no longer allows
 *     inside the schema's `datasource` block.
 *
 * Runtime connections do NOT come from here — `src/prisma-client.ts` builds a
 * PrismaPg driver adapter over a `pg.Pool`. Both read the same dedicated
 * DATABASE_URL_SHIPWRIGHT_TASK_STORE var (never a shared database).
 */

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Deliberately `process.env` rather than prisma/config's `env()` helper:
    // `env()` throws at config-load time when the var is unset, which would
    // break the DB-less `prisma generate` invocations in package.json's
    // postinstall, task-store/Dockerfile, and .github/workflows/ci.yml. The
    // v6 schema-native `env()` was lazy, so this preserves that behaviour —
    // `url` is optional here, and the migrate commands that actually need it
    // still fail loudly with Prisma's own missing-URL error.
    url: process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE,
  },
});
