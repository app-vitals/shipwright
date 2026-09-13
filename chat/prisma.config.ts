/**
 * chat/prisma.config.ts
 *
 * Prisma 7 config for the chat service. v7 moves the schema location, the
 * migrations directory and the Migrate connection URL out of CLI flags and the
 * schema file and into this config, which the CLI discovers from the working
 * directory (`cd chat && bunx prisma ...`).
 *
 * Paths are relative to this file.
 *
 * The datasource block is attached only when DATABASE_URL_SHIPWRIGHT_CHAT is
 * set: `prisma generate` runs on every `bun install` (postinstall) with no
 * database in sight, and `env()` from prisma/config throws on an unset var.
 * Commands that genuinely need a connection (`migrate deploy`/`migrate dev`)
 * are always invoked with the variable exported.
 */

import { defineConfig } from "prisma/config";

const databaseUrl = process.env.DATABASE_URL_SHIPWRIGHT_CHAT;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
