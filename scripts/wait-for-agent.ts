/**
 * scripts/wait-for-agent.ts
 * `task stack` no longer auto-seeds a dev agent (ATS-6.1) — the agent pane
 * instead polls the ADMIN database for the first Agent row a developer
 * creates via the UI (http://localhost:3001/admin/agents/new).
 *
 * This script is that poll loop: it prints a pointer message (stderr) telling
 * the developer where to create an agent, then polls `agent.findFirst()`
 * (ordered by createdAt asc — the oldest/first-created agent) on an interval
 * until a row appears, and finally prints ONLY the resolved agent id to
 * stdout. Keeping status/pointer output on stderr means a shell `$(...)`
 * capture of stdout gets a clean id with no extra noise.
 *
 * A stack relaunched with an agent already created must proceed immediately
 * (no forced delete/recreate) — findFirst() returning a row on the very first
 * poll satisfies that without any special-casing.
 *
 * Usage:
 *   bun run scripts/wait-for-agent.ts [--db-url <url>]
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** The subset of an Agent row this script needs. */
export interface FoundAgent {
  id: string;
  name: string;
  typeName: string;
}

/** Minimal Prisma interface needed by the poll function — injected for testability. */
export interface WaitPrisma {
  agent: {
    findFirst(args: {
      orderBy: { createdAt: "asc" };
    }): Promise<FoundAgent | null>;
  };
  $disconnect(): Promise<void>;
}

/** Injectable dependencies for testability. */
export interface WaitDeps {
  /** Prisma client (or double). */
  prisma: WaitPrisma;
  /** Sleep between polls — injected so tests never wait on a real timer. */
  sleep: (ms: number) => Promise<void>;
  /** Poll interval in ms. Defaults to 2000 in the CLI entrypoint. */
  intervalMs: number;
  /** Status/pointer messages — kept OFF stdout so `$(...)` captures stay clean. */
  logStatus: (line: string) => void;
  /** The final resolved id — written to stdout by the CLI entrypoint. */
  writeResult: (id: string) => void;
}

// ─── Core poll function ───────────────────────────────────────────────────────

/**
 * Prints the create-your-agent pointer, then polls `agent.findFirst()` until a
 * row appears (already-existing agent resolves on the very first poll — no
 * forced wait), and returns its id.
 */
export async function waitForAgent(deps: WaitDeps): Promise<string> {
  const { prisma, sleep, intervalMs, logStatus, writeResult } = deps;

  logStatus(
    "[wait-for-agent] no agent found yet — create one at http://localhost:3001/admin/agents/new (pick a type)",
  );
  logStatus("[wait-for-agent] waiting for an agent to be created…");

  let found = await prisma.agent.findFirst({ orderBy: { createdAt: "asc" } });
  while (!found) {
    await sleep(intervalMs);
    found = await prisma.agent.findFirst({ orderBy: { createdAt: "asc" } });
  }

  logStatus(
    `[wait-for-agent] found agent "${found.name}" (${found.id}, type: ${found.typeName}) — proceeding.`,
  );
  writeResult(found.id);
  return found.id;
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

if (import.meta.main) {
  const { PrismaClient } = await import("../admin/prisma/client/index.js");

  const argv = process.argv.slice(2);
  const dbUrl = (() => {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--db-url" && argv[i + 1]) return argv[i + 1];
      if (argv[i]?.startsWith("--db-url="))
        return argv[i].slice("--db-url=".length);
    }
    return process.env.DATABASE_URL_SHIPWRIGHT_ADMIN;
  })();

  if (!dbUrl) {
    console.error(
      "Error: DATABASE_URL_SHIPWRIGHT_ADMIN is not set. Pass --db-url <url> or set the DATABASE_URL_SHIPWRIGHT_ADMIN env var.",
    );
    process.exit(1);
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: dbUrl } },
  });

  try {
    await waitForAgent({
      prisma,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      intervalMs: 2000,
      logStatus: (line) => console.error(line),
      writeResult: (id) => console.log(id),
    });
  } finally {
    await prisma.$disconnect();
  }
}
