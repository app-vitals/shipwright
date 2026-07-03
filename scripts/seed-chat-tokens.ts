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
 * This script is invoked only by scripts/dev-tmux.ts (`task stack`) as a
 * preflight. It never runs in a deployed stack, so it changes no production
 * behavior.
 *
 *   bun run scripts/seed-chat-tokens.ts --db-url <url> \
 *     --admin-token <raw> --agent-token <raw> --agent-id <agentId>
 *
 * Pure helpers (hashRawToken, parseSeedArgs) and the upsert (seedChatTokens)
 * are exported for unit testing; the import.meta.main block wires real I/O.
 */

import { createHash } from "node:crypto";

/**
 * SHA-256 hex digest of a raw token. Mirrors the (private) hashToken in
 * chat/src/token-service.ts — the hashing contract the chat service uses to
 * validate. Kept in sync by the "known vector" unit test.
 */
export function hashRawToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface SeedArgs {
  dbUrl?: string;
  adminToken?: string;
  agentToken?: string;
  agentId?: string;
}

/** Parse CLI flags (both `--flag value` and `--flag=value`). */
export function parseSeedArgs(argv: string[]): SeedArgs {
  const read = (name: string): string | undefined => {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === `--${name}` && argv[i + 1]) return argv[i + 1];
      const prefix = `--${name}=`;
      if (argv[i]?.startsWith(prefix)) return argv[i].slice(prefix.length);
    }
    return undefined;
  };
  return {
    dbUrl: read("db-url"),
    adminToken: read("admin-token"),
    agentToken: read("agent-token"),
    agentId: read("agent-id"),
  };
}

/** Minimal slice of the chat PrismaClient this seeder needs. */
interface ChatTokenUpserter {
  chatToken: {
    upsert(args: {
      where: { token: string };
      create: { token: string; label: string | null; agentId: string | null };
      update: Record<string, never>;
    }): Promise<unknown>;
  };
}

/**
 * Idempotently upsert the two dev tokens by their hashed raw values. The empty
 * `update` makes re-runs a no-op — running `task stack` repeatedly never
 * creates duplicates or rotates a token.
 */
export async function seedChatTokens(opts: {
  prisma: ChatTokenUpserter;
  adminRawToken: string;
  agentRawToken: string;
  agentId: string;
}): Promise<void> {
  const adminHashed = hashRawToken(opts.adminRawToken);
  await opts.prisma.chatToken.upsert({
    where: { token: adminHashed },
    create: { token: adminHashed, label: "dev-admin", agentId: null },
    update: {},
  });

  const agentHashed = hashRawToken(opts.agentRawToken);
  await opts.prisma.chatToken.upsert({
    where: { token: agentHashed },
    create: {
      token: agentHashed,
      label: `dev-agent (${opts.agentId})`,
      agentId: opts.agentId,
    },
    update: {},
  });
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

if (import.meta.main) {
  const { PrismaClient } = await import("../chat/prisma/client/index.js");

  const { dbUrl, adminToken, agentToken, agentId } = parseSeedArgs(
    process.argv.slice(2),
  );
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

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  try {
    await seedChatTokens({
      prisma: prisma as unknown as ChatTokenUpserter,
      adminRawToken: adminToken,
      agentRawToken: agentToken,
      agentId,
    });
    console.log(
      "[seed-chat-tokens] admin + agent tokens ready (idempotent upsert).",
    );
  } finally {
    await prisma.$disconnect();
  }
}
