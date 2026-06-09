/**
 * scripts/dev-tmux.unit.test.ts
 * Unit tests for scripts/dev-tmux.ts — the pure tmux command/pane-env builder.
 *
 * Mirrors the dev.ts injected-spawn pattern: runStack(panes, exec) drives an
 * INJECTED exec function so we assert the exact ordered tmux command sequence
 * and per-pane env WITHOUT spawning real tmux. No mock.module(), no global.*.
 *
 * Why no real-tmux spawn test: the only remaining behavior is I/O-bound (does
 * tmux exist + does the OS run the argv). That seam is the injected `exec`,
 * fully covered here; a real-tmux/real-network E2E would be slow, flaky, and
 * environment-dependent for zero added confidence over the builder assertions.
 */

import { describe, expect, test } from "bun:test";
import {
  AGENT_PORT,
  brewFormulaInstalled,
  buildStackCommands,
  dbReachable,
  missingWorkspaceDeps,
  type Pane,
  planPostgresSetup,
  runStack,
  SESSION_NAME,
  sessionExists,
  sessionExistsMessage,
  STACK_PANES,
} from "./dev-tmux.ts";

// ---------------------------------------------------------------------------
// Recording fake exec — captures every argv + env passed to it
// ---------------------------------------------------------------------------

function makeRecorder() {
  const calls: { argv: string[]; env?: Record<string, string> }[] = [];
  const exec = (argv: string[], env?: Record<string, string>) => {
    calls.push({ argv, env });
  };
  return { calls, exec };
}

// Find the send-keys argv that targets a given pane index.
function sendKeysForPane(
  calls: { argv: string[] }[],
  paneIndex: number,
): string[] | undefined {
  return calls
    .map((c) => c.argv)
    .find(
      (argv) =>
        argv[0] === "send-keys" &&
        argv.includes("-t") &&
        argv.some((a) => a === `${SESSION_NAME}:0.${paneIndex}`),
    );
}

describe("buildStackCommands", () => {
  test("creates a session named 'shipwright'", () => {
    const cmds = buildStackCommands(STACK_PANES);
    const newSession = cmds.find((c) => c.argv[0] === "new-session");
    expect(newSession).toBeDefined();
    expect(newSession?.argv).toContain("-s");
    expect(newSession?.argv).toContain(SESSION_NAME);
  });

  test("uses a single window with 4 panes (1 new-session + 3 split-window)", () => {
    const cmds = buildStackCommands(STACK_PANES);
    const newSessions = cmds.filter((c) => c.argv[0] === "new-session");
    const splits = cmds.filter((c) => c.argv[0] === "split-window");
    expect(newSessions.length).toBe(1);
    expect(splits.length).toBe(3);
  });

  test("runs the migration preflight BEFORE the agent pane is started", () => {
    const cmds = buildStackCommands(STACK_PANES);
    const preflightIdx = cmds.findIndex((c) =>
      c.argv.join(" ").includes("migrate deploy"),
    );
    const agentSendKeysIdx = cmds.findIndex(
      (c) =>
        c.argv[0] === "send-keys" &&
        c.argv.some((a) => a.includes("agent/src/run-agent.ts")),
    );
    expect(preflightIdx).toBeGreaterThanOrEqual(0);
    expect(agentSendKeysIdx).toBeGreaterThanOrEqual(0);
    expect(preflightIdx).toBeLessThan(agentSendKeysIdx);
  });

  test("the preflight runs prisma migrate deploy", () => {
    const cmds = buildStackCommands(STACK_PANES);
    const preflight = cmds.find((c) =>
      c.argv.join(" ").includes("migrate deploy"),
    );
    expect(preflight).toBeDefined();
    expect(preflight?.kind).toBe("preflight");
  });

  test("the preflight generates the Prisma client BEFORE migrating", () => {
    // The agent imports admin/prisma/client — `bun install` does not generate
    // it, so the preflight must, or the agent pane crashes on a missing module.
    const cmds = buildStackCommands(STACK_PANES);
    const preflight = cmds.find((c) => c.kind === "preflight");
    const cmd = preflight?.argv.join(" ") ?? "";
    expect(cmd).toContain("prisma generate");
    expect(cmd.indexOf("prisma generate")).toBeLessThan(
      cmd.indexOf("migrate deploy"),
    );
  });
});

describe("runStack — per-pane commands via injected exec", () => {
  test("metrics pane runs the metrics server with METRICS_OFFLINE=true", () => {
    const { calls, exec } = makeRecorder();
    runStack(STACK_PANES, exec);
    const sk = sendKeysForPane(calls, 0);
    expect(sk?.join(" ")).toContain("metrics/src/server.ts");
    expect(sk?.join(" ")).toContain("METRICS_OFFLINE=true");
  });

  test("agent pane runs run-agent.ts with the full dev-chat env", () => {
    const { calls, exec } = makeRecorder();
    runStack(STACK_PANES, exec);
    const sk = sendKeysForPane(calls, 1)?.join(" ") ?? "";
    expect(sk).toContain("agent/src/run-agent.ts");
    expect(sk).toContain(`PORT=${AGENT_PORT}`);
    expect(sk).toContain("SHIPWRIGHT_DEV_CHAT=true");
    expect(sk).toContain("POSTHOG_HOST=http://localhost:3460");
    expect(sk).toContain("POSTHOG_PROJECT_API_KEY=");
    expect(sk).toContain("DATABASE_URL=");
    expect(sk).toContain("SHIPWRIGHT_ENCRYPTION_KEY=");
    expect(sk).toContain("AGENT_HOME=state/agent-home");
  });

  test("chat pane runs scripts/chat.ts", () => {
    const { calls, exec } = makeRecorder();
    runStack(STACK_PANES, exec);
    const sk = sendKeysForPane(calls, 2)?.join(" ") ?? "";
    expect(sk).toContain("scripts/chat.ts");
  });

  test("logs pane is a scratch shell (no server command)", () => {
    const logs = STACK_PANES[3];
    expect(logs.label).toBe("logs");
    // scratch shell: no long-running bun server entry
    expect(logs.cmd.join(" ")).not.toContain("server.ts");
    expect(logs.cmd.join(" ")).not.toContain("run-agent.ts");
  });

  test("exec is invoked once per built command, in order", () => {
    const { calls, exec } = makeRecorder();
    const built = buildStackCommands(STACK_PANES);
    runStack(STACK_PANES, exec);
    expect(calls.length).toBe(built.length);
    expect(calls.map((c) => c.argv)).toEqual(built.map((c) => c.argv));
  });
});

describe("pane env values are obviously dev dummies (public-safe)", () => {
  test("agent pane dummy keys look like dev placeholders", () => {
    const agent = STACK_PANES.find((p) => p.label === "agent") as Pane;
    expect(agent.env?.POSTHOG_PROJECT_API_KEY).toContain("dev");
    // 64-hex dummy encryption key
    expect(agent.env?.SHIPWRIGHT_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(agent.env?.DATABASE_URL).toContain("postgresql:");
  });
});

describe("ports", () => {
  test("agent pane is wired for :3000", () => {
    expect(AGENT_PORT).toBe(3000);
  });
});

describe("sessionExists — pre-flight guard against duplicate sessions", () => {
  test("true when has-session probe exits 0 (session present)", () => {
    const probed: string[] = [];
    const exists = sessionExists(SESSION_NAME, (n) => {
      probed.push(n);
      return 0;
    });
    expect(exists).toBe(true);
    expect(probed).toEqual([SESSION_NAME]);
  });

  test("false when has-session probe exits non-zero (no session)", () => {
    expect(sessionExists(SESSION_NAME, () => 1)).toBe(false);
  });

  test("guidance message offers both attach and reset paths", () => {
    const msg = sessionExistsMessage(SESSION_NAME);
    expect(msg).toContain(`tmux attach -t ${SESSION_NAME}`);
    expect(msg).toContain(`tmux kill-session -t ${SESSION_NAME}`);
  });
});

describe("dbReachable — pre-flight guard for the migrate preflight", () => {
  const URL_STR = "postgresql://localhost:5432/shipwright_dev";

  test("parses host + port from the database URL and passes them to the probe", async () => {
    let seen: { host: string; port: number } | undefined;
    await dbReachable(URL_STR, async (host, port) => {
      seen = { host, port };
      return true;
    });
    expect(seen).toEqual({ host: "localhost", port: 5432 });
  });

  test("true when the probe connects", async () => {
    expect(await dbReachable(URL_STR, async () => true)).toBe(true);
  });

  test("false when the probe cannot connect", async () => {
    expect(await dbReachable(URL_STR, async () => false)).toBe(false);
  });

});

describe("missingWorkspaceDeps — deps guard", () => {
  const DIRS = ["metrics", "agent", "admin"];

  test("none missing when every workspace has node_modules", () => {
    expect(missingWorkspaceDeps(DIRS, () => true)).toEqual([]);
  });

  test("reports exactly the workspaces lacking node_modules", () => {
    // Mirrors the real bug: admin added after a prior install has no deps.
    const installed = new Set(["metrics", "agent"]);
    expect(missingWorkspaceDeps(DIRS, (d) => installed.has(d))).toEqual([
      "admin",
    ]);
  });

  test("reports all when nothing is installed (fresh clone)", () => {
    expect(missingWorkspaceDeps(DIRS, () => false)).toEqual(DIRS);
  });
});

describe("brewFormulaInstalled", () => {
  test("true when `brew list` exits 0", () => {
    expect(brewFormulaInstalled("postgresql@16", () => 0)).toBe(true);
  });
  test("false when `brew list` exits non-zero", () => {
    expect(brewFormulaInstalled("postgresql@16", () => 1)).toBe(false);
  });
  test("queries the named formula", () => {
    let seen: string[] = [];
    brewFormulaInstalled("postgresql@16", (argv) => {
      seen = argv;
      return 0;
    });
    expect(seen).toEqual(["brew", "list", "--formula", "postgresql@16"]);
  });
});

describe("planPostgresSetup — auto vs guide ladder", () => {
  const URL_STR = "postgresql://me@localhost:5432/shipwright_dev";

  test("reachable: no bring-up steps, but flags the missing DB + createdb", () => {
    const plan = planPostgresSetup({
      databaseUrl: URL_STR,
      reachable: true,
      formulaInstalled: true,
    });
    expect(plan.serverReady).toBe(true);
    expect(plan.steps).toEqual([]);
    expect(plan.instructions).toContain("createdb shipwright_dev");
  });

  test("not running but installed: start only (no install step)", () => {
    const plan = planPostgresSetup({
      databaseUrl: URL_STR,
      reachable: false,
      formulaInstalled: true,
    });
    const displays = plan.steps.map((s) => s.display);
    expect(displays).toEqual(["brew services start postgresql@16"]);
    expect(plan.instructions).toContain("not running");
  });

  test("not installed: install then start, in that order", () => {
    const plan = planPostgresSetup({
      databaseUrl: URL_STR,
      reachable: false,
      formulaInstalled: false,
    });
    expect(plan.steps.map((s) => s.display)).toEqual([
      "brew install postgresql@16",
      "brew services start postgresql@16",
    ]);
    // every step carries an executable argv
    expect(plan.steps.every((s) => s.argv[0] === "sh")).toBe(true);
  });

  test("instructions always show the createdb line for the user", () => {
    const plan = planPostgresSetup({
      databaseUrl: URL_STR,
      reachable: false,
      formulaInstalled: false,
    });
    expect(plan.instructions).toContain("createdb shipwright_dev");
  });
});
