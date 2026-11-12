/**
 * scripts/seed-chat-tokens.ts
 * Local-dev only — seed known tokens into the chat-service database so the
 * `task stack` panes can talk to it without manual token provisioning:
 *
 *   - an admin token (agentId null, unrestricted) handed to the admin pane as
 *     SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN, enabling the /admin/chat UI
 *   - an agent-scoped token (agentId set) handed to the agent container as
 *     SHIPWRIGHT_CHAT_SERVICE_TOKEN, enabling the chat poll loop
 *
 * Why this exists: chat tokens are stored as a SHA-256 hash of the raw value,
 * so a *known* dev token can't be minted via ChatTokenService.create() (which
 * generates a random raw); we upsert the hashes directly. Mirrors
 * scripts/seed-task-store-token.ts.
 *
 * The chat service is hosted in app-vitals/agent (CHX-3.3); this script writes
 * to its `ChatToken` table over plain SQL (Bun.SQL), so it needs no chat
 * workspace or Prisma client from this repo.
 *
 * This script is invoked only by scripts/dev-tmux.ts (`task stack`) from the
 * agent pane's script. It never runs in a deployed stack, so it changes no production
 * behavior.
 *
 *   bun run scripts/seed-chat-tokens.ts --db-url <url> \
 *     --admin-token <raw> --agent-token <raw> --agent-id <agentId>
 *
 * Pure helpers (hashRawToken) and the insert (seedChatTokens) are exported
 * for unit testing; the import.meta.main block wires real I/O. CLI flags are
 * parsed via the shared @app-vitals/agent-lib/cli-flags#parseFlags helper.
 */

import { createHash, randomUUID } from "node:crypto";
import { parseFlags } from "@app-vitals/agent-lib/cli-flags";

/**
 * SHA-256 hex digest of a raw token. Mirrors the (private) hashToken in
 * the platform repo's chat/src/token-service.ts — the hashing contract the chat service uses to
 * validate. Kept in sync by the "known vector" unit test.
 */
export function hashRawToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** A ChatToken row to insert (the seeder never sets id/createdAt/revokedAt). */
export interface ChatTokenRow {
  token: string;
  label: string | null;
  agentId: string | null;
}

/** Minimal slice of the chat database this seeder needs. */
export interface ChatTokenStore {
  /** Insert the row unless a row with the same (hashed) token exists. */
  insertIfAbsent(row: ChatTokenRow): Promise<void>;
}

/**
 * Idempotently insert the two dev tokens by their hashed raw values. The
 * insert-if-absent makes re-runs a no-op — running `task stack` repeatedly
 * never creates duplicates or rotates a token.
 */
export async function seedChatTokens(opts: {
  store: ChatTokenStore;
  adminRawToken: string;
  agentRawToken: string;
  agentId: string;
}): Promise<void> {
  await opts.store.insertIfAbsent({
    token: hashRawToken(opts.adminRawToken),
    label: "dev-admin",
    agentId: null,
  });
  await opts.store.insertIfAbsent({
    token: hashRawToken(opts.agentRawToken),
    label: `dev-agent (${opts.agentId})`,
    agentId: opts.agentId,
  });
}

/**
 * ChatTokenStore over a Postgres URL using Bun's built-in SQL client. The chat
 * service now lives in app-vitals/agent (CHX-3.3), so this repo no longer has
 * its Prisma client to import — the seeder talks to the platform's `ChatToken`
 * table directly. `id` has only a client-side (Prisma cuid) default, so we
 * supply one.
 */
export function createChatTokenStore(
  databaseUrl: string,
): ChatTokenStore & { close(): Promise<void> } {
  const sql = new Bun.SQL(databaseUrl);
  return {
    async insertIfAbsent(row) {
      await sql`INSERT INTO "ChatToken" ("id", "token", "label", "agentId")
        VALUES (${randomUUID()}, ${row.token}, ${row.label}, ${row.agentId})
        ON CONFLICT ("token") DO NOTHING`;
    },
    close: () => sql.close(),
  };
}

/** True for Postgres "undefined_table" (42P01): the chat service has not migrated yet. */
export function isMissingTableError(err: unknown): boolean {
  const e = err as { code?: string; errno?: string; message?: string };
  return (
    e?.code === "42P01" ||
    e?.errno === "42P01" ||
    /relation "ChatToken" does not exist/.test(e?.message ?? "")
  );
}

/**
 * Run `fn`, retrying while the ChatToken table is missing. The platform chat
 * service migrates its own database on boot, and `task stack` starts it in a
 * sibling pane, so the first attempt can race that migration.
 */
export async function retryUntilMigrated<T>(
  fn: () => Promise<T>,
  opts: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 30;
  const delayMs = opts.delayMs ?? 2000;
  const sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isMissingTableError(err) || i >= attempts) throw err;
      await sleep(delayMs);
    }
  }
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

if (import.meta.main) {
  const flags = parseFlags(process.argv.slice(2), [
    "--db-url",
    "--admin-token",
    "--agent-token",
    "--agent-id",
  ] as const);
  const dbUrl = flags["--db-url"];
  const adminToken = flags["--admin-token"];
  const agentToken = flags["--agent-token"];
  const agentId = flags["--agent-id"];
  const databaseUrl = dbUrl ?? process.env.DATABASE_URL_SHIPWRIGHT_CHAT;

  if (!databaseUrl) {
    console.error(
      "[seed-chat-tokens] No database URL — pass --db-url <url> or set DATABASE_URL_SHIPWRIGHT_CHAT.",
    );
    process.exit(1);
  }
  if (!adminToken || !agentToken || !agentId) {
    console.error(
      "[seed-chat-tokens] Missing flags — pass --admin-token, --agent-token, and --agent-id.",
    );
    process.exit(1);
  }

  const store = createChatTokenStore(databaseUrl);
  try {
    await retryUntilMigrated(() =>
      seedChatTokens({
        store,
        adminRawToken: adminToken,
        agentRawToken: agentToken,
        agentId,
      }),
    );
    console.log(
      "[seed-chat-tokens] admin + agent tokens ready (idempotent insert).",
    );
  } catch (err) {
    console.error(
      `[seed-chat-tokens] failed to seed tokens: ${(err as Error).message}`,
    );
    process.exitCode = 1;
  } finally {
    await store.close();
  }
}
