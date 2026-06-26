/**
 * scripts/seed-task-store-token.ts
 * Local-dev only — seed an admin token into the task-store database so the admin
 * console (`task stack`) can read/manage tasks and PRs.
 *
 * Why this exists: the admin service only builds its task-store client when both
 * SHIPWRIGHT_TASK_STORE_URL and SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN are set, and the
 * task-store rejects unauthenticated requests (401). An "admin token" is a
 * `TaskToken` row with `agentId = null` (unrestricted). Tokens are stored as a
 * SHA-256 hash of the raw value, so a *known* dev token can't be minted via
 * TaskTokenService.create() (which generates a random raw); we upsert the hash
 * directly. The same raw value is handed to the admin pane verbatim.
 *
 * This script is invoked only by scripts/dev-tmux.ts (`task stack`) as a preflight.
 * It never runs in a deployed stack, so it changes no production behavior.
 *
 *   bun run scripts/seed-task-store-token.ts --db-url <url> --token <rawToken>
 *
 * Pure helpers (hashRawToken, parseSeedArgs) and the upsert (seedTaskStoreAdminToken)
 * are exported for unit testing; the import.meta.main block wires real I/O.
 */

import { createHash } from "node:crypto";

/**
 * SHA-256 hex digest of a raw token. Mirrors the (private) hashToken in
 * task-store/src/token-service.ts — the hashing contract the task-store uses to
 * validate. Kept in sync by the "known vector" unit test.
 */
export function hashRawToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface SeedArgs {
  dbUrl?: string;
  token?: string;
}

/** Parse `--db-url`/`--token` flags (both `--flag value` and `--flag=value`). */
export function parseSeedArgs(argv: string[]): SeedArgs {
  const read = (name: string): string | undefined => {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === `--${name}` && argv[i + 1]) return argv[i + 1];
      const prefix = `--${name}=`;
      if (argv[i]?.startsWith(prefix)) return argv[i].slice(prefix.length);
    }
    return undefined;
  };
  return { dbUrl: read("db-url"), token: read("token") };
}

/** Minimal slice of PrismaClient this seeder needs — keeps the double tiny. */
interface TaskTokenUpserter {
  taskToken: {
    upsert(args: {
      where: { token: string };
      create: { token: string; label: string | null; agentId: null };
      update: Record<string, never>;
    }): Promise<unknown>;
  };
}

/**
 * Idempotently upsert an admin token (agentId null) by its hashed raw value.
 * The empty `update` makes re-runs a no-op — running `task stack` repeatedly
 * never creates duplicates or rotates the token.
 */
export async function seedTaskStoreAdminToken(opts: {
  prisma: TaskTokenUpserter;
  rawToken: string;
  label?: string;
}): Promise<void> {
  const hashed = hashRawToken(opts.rawToken);
  await opts.prisma.taskToken.upsert({
    where: { token: hashed },
    create: { token: hashed, label: opts.label ?? null, agentId: null },
    update: {},
  });
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

if (import.meta.main) {
  const { PrismaClient } = await import(
    "../task-store/prisma/client/index.js"
  );

  const { dbUrl, token } = parseSeedArgs(process.argv.slice(2));
  const databaseUrl = dbUrl ?? process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE;

  if (!databaseUrl) {
    console.error(
      "[seed-task-store-token] No database URL — pass --db-url <url> or set DATABASE_URL_SHIPWRIGHT_TASK_STORE.",
    );
    process.exit(1);
  }
  if (!token) {
    console.error(
      "[seed-task-store-token] No token — pass --token <rawToken>.",
    );
    process.exit(1);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await seedTaskStoreAdminToken({
      // biome-ignore lint/suspicious/noExplicitAny: generated client satisfies the upsert slice
      prisma: prisma as any,
      rawToken: token,
      label: "dev-admin",
    });
    console.log(
      "[seed-task-store-token] admin token ready (idempotent upsert).",
    );
  } finally {
    await prisma.$disconnect();
  }
}
