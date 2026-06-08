/**
 * scripts/dev.ts
 * Local dev supervisor — spawns child services and stops all on a single SIGINT.
 *
 * Usage:
 *   bun scripts/dev.ts
 *
 * Architecture:
 *   Children are declared as a ChildConfig array. The supervisor spawns each
 *   child, waits for all to exit, and forwards SIGINT to all children on
 *   Ctrl-C. Adding a second child (e.g. agent) requires only a new entry in
 *   the CHILDREN array — no structural rework.
 *
 * Testability:
 *   createSupervisor(children, spawnFn?) accepts an optional spawn override so
 *   unit tests can inject fake child handles without spawning real processes.
 *   shutdownWithChildren(handles) is exposed for direct injection in tests.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChildConfig = {
  cmd: string[];
  label: string;
  env?: Record<string, string>;
};

export type ChildHandle = {
  label: string;
  kill: (signal?: string) => void;
  exited: Promise<void>;
};

type SpawnFn = (config: ChildConfig) => ChildHandle;

export type Supervisor = {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  shutdownWithChildren(handles: ChildHandle[]): Promise<void>;
};

// ---------------------------------------------------------------------------
// Default spawn implementation using Bun.spawn
// ---------------------------------------------------------------------------

function defaultSpawn(config: ChildConfig): ChildHandle {
  const proc = Bun.spawn(config.cmd, {
    env: {
      ...process.env,
      ...(config.env ?? {}),
    },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  return {
    label: config.label,
    kill: (signal?: string) => {
      proc.kill(signal as NodeJS.Signals | undefined);
    },
    exited: proc.exited.then(() => {}),
  };
}

// ---------------------------------------------------------------------------
// Supervisor factory
// ---------------------------------------------------------------------------

export function createSupervisor(
  children: ChildConfig[],
  spawnFn: SpawnFn = defaultSpawn,
): Supervisor {
  async function shutdownWithChildren(handles: ChildHandle[]): Promise<void> {
    if (handles.length === 0) return;
    for (const handle of handles) {
      handle.kill("SIGINT");
    }
    await Promise.all(handles.map((h) => h.exited));
    console.log("[dev] all services stopped");
  }

  async function start(): Promise<void> {
    const handles: ChildHandle[] = [];

    for (const config of children) {
      console.log(`[dev] starting ${config.label}...`);
      const handle = spawnFn(config);
      handles.push(handle);
    }

    process.on("SIGINT", () => {
      void shutdownWithChildren(handles).then(() => {
        process.exit(0);
      });
    });

    await Promise.all(handles.map((h) => h.exited));
  }

  async function shutdown(): Promise<void> {
    // Called externally — callers should use shutdownWithChildren directly
    // for injection in tests, or let SIGINT handler do it.
  }

  return { start, shutdown, shutdownWithChildren };
}

// ---------------------------------------------------------------------------
// Child definitions — add new services here
// ---------------------------------------------------------------------------

const CHILDREN: ChildConfig[] = [
  {
    cmd: ["bun", "run", "metrics/src/server.ts"],
    label: "metrics-api",
    env: { METRICS_OFFLINE: "true" },
  },
  // Future: agent service will be added here as a second entry
  // { cmd: ["bun", "run", "agent/src/server.ts"], label: "agent", env: { ... } },
];

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const supervisor = createSupervisor(CHILDREN);
  await supervisor.start();
}
