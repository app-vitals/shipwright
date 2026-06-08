/**
 * scripts/dev.ts
 * Dev supervisor — spawns child processes and kills all on a single SIGINT.
 *
 * Currently manages one child (the metrics server in offline mode). Structured
 * so a second child (the agent) can be added to buildChildren() later with no
 * rework to the supervisor loop or shutdown handler.
 *
 * Usage: bun scripts/dev.ts
 */

export interface ChildDef {
  label: string;
  cmd: string[];
  env?: Record<string, string>;
}

/**
 * Returns the list of child processes to spawn.
 * Add a new entry here to add a concurrent child to `task dev`.
 */
export function buildChildren(): ChildDef[] {
  return [
    {
      label: "metrics",
      cmd: ["bun", "metrics/src/server.ts"],
      env: { METRICS_OFFLINE: "true" },
    },
  ];
}

/**
 * Returns an async cleanup function that kills all passed processes and logs
 * a shutdown message. Safe to call with an empty list.
 */
export function createShutdownHandler(
  procs: Array<{ kill(): void; label: string }>,
): () => Promise<void> {
  return async () => {
    console.log("[dev] Shutting down...");
    for (const proc of procs) {
      proc.kill();
    }
  };
}

/**
 * Spawns all children from buildChildren(), registers SIGINT/SIGTERM shutdown,
 * and awaits all processes.
 */
export async function runDev(): Promise<void> {
  const children = buildChildren();
  const spawned: Array<{ proc: ReturnType<typeof Bun.spawn>; label: string }> =
    [];

  for (const child of children) {
    const proc = Bun.spawn(child.cmd, {
      env: { ...process.env, ...(child.env ?? {}) },
      stdout: "inherit",
      stderr: "inherit",
    });
    spawned.push({ proc, label: child.label });
    console.log(
      `[dev] Started ${child.label} — http://localhost:3460/dashboard`,
    );
  }

  const shutdown = createShutdownHandler(
    spawned.map(({ proc, label }) => ({
      label,
      kill: () => proc.kill(),
    })),
  );

  process.on("SIGINT", () => {
    shutdown().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    shutdown().then(() => process.exit(0));
  });

  // Await all child processes
  await Promise.all(spawned.map(({ proc }) => proc.exited));
}

if (import.meta.main) {
  runDev().catch(console.error);
}
