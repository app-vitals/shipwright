/**
 * agent/src/run-migrations.unit.test.ts
 *
 * Unit tests for the runMigrations() preflight in run-agent.ts.
 *
 * Strategy: inject a fake `spawn` and a fixed `metaDir` so no real prisma
 * command ever runs. Tests assert the resolved `cwd` path, the spawn args,
 * and early-exit behaviour when DATABASE_URL_AGENT is unset.
 *
 * No mock.module(), no global.* overrides — uses the injected-seam pattern.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { runMigrations } from "./run-agent.ts";

// ─── Fake spawn factory ───────────────────────────────────────────────────────

interface SpawnCall {
  cmd: string[];
  opts: { cwd?: string; env?: Record<string, string | undefined> };
}

/**
 * Returns a fake spawn function that records its call arguments and resolves
 * as a successful process (exit code 0).
 */
function makeFakeSpawn(exitCode = 0): {
  spawn: typeof Bun.spawn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];

  const fakeProc = {
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    }),
    exited: Promise.resolve(exitCode),
    exitCode,
  } as unknown as ReturnType<typeof Bun.spawn>;

  const spawn = ((cmd: string[], opts: SpawnCall["opts"]) => {
    calls.push({ cmd, opts: opts ?? {} });
    return fakeProc;
  }) as unknown as typeof Bun.spawn;

  return { spawn, calls };
}

// ─── cwd resolution ──────────────────────────────────────────────────────────

describe("runMigrations — cwd resolution", () => {
  it("resolves cwd to <metaDir>/../../admin (two levels up then admin/)", async () => {
    const { spawn, calls } = makeFakeSpawn();
    const metaDir = "/repo/agent/src";

    await runMigrations({
      spawn,
      metaDir,
      env: { DATABASE_URL_AGENT: "file:./dev.db" },
    });

    expect(calls).toHaveLength(1);
    const resolved = calls[0].opts.cwd;
    expect(resolved).toBe(join(metaDir, "../../admin"));
    // Confirm it resolves to <repo>/admin — not <repo>/agent or <repo>/agent/src
    expect(resolved).toBe("/repo/admin");
  });

  it("passes DATABASE_URL_AGENT through to spawn env", async () => {
    const { spawn, calls } = makeFakeSpawn();
    const dbUrl = "postgresql://user:pass@localhost/db";

    await runMigrations({
      spawn,
      metaDir: "/repo/agent/src",
      env: { DATABASE_URL_AGENT: dbUrl },
    });

    expect(calls[0].opts.env?.DATABASE_URL_AGENT).toBe(dbUrl);
  });
});

// ─── spawn args ──────────────────────────────────────────────────────────────

describe("runMigrations — spawn command", () => {
  it("calls prisma migrate deploy with the correct args", async () => {
    const { spawn, calls } = makeFakeSpawn();

    await runMigrations({
      spawn,
      metaDir: "/repo/agent/src",
      env: { DATABASE_URL_AGENT: "file:./dev.db" },
    });

    expect(calls[0].cmd).toEqual([
      "bunx",
      "prisma",
      "migrate",
      "deploy",
      "--schema=prisma/schema.prisma",
    ]);
  });
});

// ─── early exit when DATABASE_URL_AGENT is unset ─────────────────────────────

describe("runMigrations — early exit", () => {
  it("does not spawn when DATABASE_URL_AGENT is absent", async () => {
    const { spawn, calls } = makeFakeSpawn();

    await runMigrations({ spawn, metaDir: "/repo/agent/src", env: {} });

    expect(calls).toHaveLength(0);
  });

  it("does not throw when DATABASE_URL_AGENT is absent", async () => {
    const { spawn } = makeFakeSpawn();

    await expect(
      runMigrations({ spawn, metaDir: "/repo/agent/src", env: {} }),
    ).resolves.toBeUndefined();
  });
});

// ─── failure propagation ─────────────────────────────────────────────────────

describe("runMigrations — failure propagation", () => {
  it("throws when spawn exits with non-zero code", async () => {
    const { spawn } = makeFakeSpawn(1);

    await expect(
      runMigrations({
        spawn,
        metaDir: "/repo/agent/src",
        env: { DATABASE_URL_AGENT: "file:./dev.db" },
      }),
    ).rejects.toThrow("prisma migrate deploy exited with code 1");
  });
});
