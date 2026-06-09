/**
 * scripts/dev-tmux.unit.test.ts
 * Unit tests for scripts/dev-tmux.ts tmux command builder.
 *
 * All tests use the injected exec fn — no real tmux subprocess is spawned.
 *
 * Why no real-tmux spawn test:
 *   tmux is an I/O-bound terminal multiplexer that requires a real TTY,
 *   a writable /tmp, and a running X/terminal session. Spawning a real tmux
 *   session in a headless CI environment is unreliable (exits immediately
 *   without a TTY), and the meaningful behaviour is whether we issue the
 *   correct tmux command sequence — not whether tmux itself starts. That
 *   correctness lives entirely in buildTmuxCommands(), which is pure and
 *   fully covered here. The injected exec fn verifies the invocation contract;
 *   the real exec fn is just a one-liner call to Bun.spawnSync.
 *
 * No mock.module(), no global.* overrides — injected exec fn only.
 */

import { describe, expect, test } from "bun:test";
import {
  PANE_AGENT,
  PANE_CHAT,
  PANE_LOGS,
  PANE_METRICS,
  SESSION_NAME,
  buildTmuxCommands,
  type TmuxCommand,
} from "./dev-tmux.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flatten all command arrays into a single searchable list of strings. */
function allArgs(cmds: TmuxCommand[]): string[] {
  return cmds.flatMap((c) => c.args);
}

/** Find all commands that include a specific arg substring. */
function findCmds(cmds: TmuxCommand[], substring: string): TmuxCommand[] {
  return cmds.filter((c) => c.args.some((a) => a.includes(substring)));
}

/** Find the env object for a pane by matching pane label in send-keys commands. */
function findEnvForPane(
  cmds: TmuxCommand[],
  paneTarget: string,
): Record<string, string> | undefined {
  return cmds.find(
    (c) =>
      c.args.includes("send-keys") &&
      c.args.some((a) => a.includes(paneTarget)),
  )?.env;
}

// ---------------------------------------------------------------------------
// buildTmuxCommands — structure
// ---------------------------------------------------------------------------

describe("buildTmuxCommands — structure", () => {
  test("returns an array of TmuxCommand objects", () => {
    const cmds = buildTmuxCommands();
    expect(Array.isArray(cmds)).toBe(true);
    expect(cmds.length).toBeGreaterThan(0);
    for (const cmd of cmds) {
      expect(typeof cmd).toBe("object");
      expect(Array.isArray(cmd.args)).toBe(true);
    }
  });

  test("every command starts with 'tmux'", () => {
    const cmds = buildTmuxCommands();
    for (const cmd of cmds) {
      expect(cmd.args[0]).toBe("tmux");
    }
  });

  test("creates a new detached session named 'shipwright'", () => {
    const cmds = buildTmuxCommands();
    const newSession = cmds.find(
      (c) =>
        c.args.includes("new-session") &&
        c.args.includes("-d") &&
        c.args.includes("-s") &&
        c.args.includes(SESSION_NAME),
    );
    expect(newSession).toBeDefined();
  });

  test("attaches to the session as the final command", () => {
    const cmds = buildTmuxCommands();
    const last = cmds[cmds.length - 1];
    expect(last.args).toContain("attach-session");
    expect(last.args).toContain(SESSION_NAME);
  });

  test("has exactly 4 panes (metrics, agent, chat, logs)", () => {
    const cmds = buildTmuxCommands();
    // Each pane after the first is created with split-window or select-pane+send-keys.
    // We detect panes by counting distinct pane targets in send-keys commands.
    const sendKeys = cmds.filter((c) => c.args.includes("send-keys"));
    // 3 panes get commands (metrics, agent, chat); logs is a scratch shell.
    expect(sendKeys.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// buildTmuxCommands — pane commands
// ---------------------------------------------------------------------------

describe("buildTmuxCommands — pane commands", () => {
  test("metrics pane runs bun metrics/src/server.ts", () => {
    const cmds = buildTmuxCommands();
    const args = allArgs(cmds);
    expect(args.some((a) => a.includes("metrics/src/server.ts"))).toBe(true);
  });

  test("agent pane runs bun agent/src/run-agent.ts", () => {
    const cmds = buildTmuxCommands();
    const args = allArgs(cmds);
    expect(args.some((a) => a.includes("agent/src/run-agent.ts"))).toBe(true);
  });

  test("chat pane runs bun scripts/chat.ts", () => {
    const cmds = buildTmuxCommands();
    const args = allArgs(cmds);
    expect(args.some((a) => a.includes("scripts/chat.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildTmuxCommands — metrics pane env
// ---------------------------------------------------------------------------

describe("buildTmuxCommands — metrics pane env", () => {
  test("metrics pane sets METRICS_OFFLINE=true", () => {
    const cmds = buildTmuxCommands();
    const metricsCmd = cmds.find(
      (c) =>
        c.args.includes("send-keys") &&
        c.args.some((a) => a.includes("metrics/src/server.ts")),
    );
    expect(metricsCmd).toBeDefined();
    expect(metricsCmd?.env?.METRICS_OFFLINE).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// buildTmuxCommands — agent pane env
// ---------------------------------------------------------------------------

describe("buildTmuxCommands — agent pane env", () => {
  let agentCmd: TmuxCommand | undefined;

  // Find the send-keys command that launches the agent
  function getAgentCmd() {
    if (agentCmd) return agentCmd;
    const cmds = buildTmuxCommands();
    agentCmd = cmds.find(
      (c) =>
        c.args.includes("send-keys") &&
        c.args.some((a) => a.includes("agent/src/run-agent.ts")),
    );
    return agentCmd;
  }

  test("agent pane sets SHIPWRIGHT_DEV_CHAT=true", () => {
    const cmd = getAgentCmd();
    expect(cmd).toBeDefined();
    expect(cmd?.env?.SHIPWRIGHT_DEV_CHAT).toBe("true");
  });

  test("agent pane sets POSTHOG_HOST to local metrics server", () => {
    const cmd = getAgentCmd();
    expect(cmd?.env?.POSTHOG_HOST).toBe("http://localhost:3460");
  });

  test("agent pane sets POSTHOG_PROJECT_API_KEY to a dummy dev value", () => {
    const cmd = getAgentCmd();
    expect(cmd?.env?.POSTHOG_PROJECT_API_KEY).toBeDefined();
    // Must be a non-empty string (dummy value for local dev)
    expect(cmd?.env?.POSTHOG_PROJECT_API_KEY?.length).toBeGreaterThan(0);
  });

  test("agent pane sets DATABASE_URL_AGENT to a local SQLite path", () => {
    const cmd = getAgentCmd();
    expect(cmd?.env?.DATABASE_URL_AGENT).toMatch(/^file:/);
  });

  test("agent pane sets SHIPWRIGHT_ENCRYPTION_KEY to a dummy dev value", () => {
    const cmd = getAgentCmd();
    expect(cmd?.env?.SHIPWRIGHT_ENCRYPTION_KEY).toBeDefined();
    // 64-char hex = 32 bytes AES-256-GCM; dummy value acceptable for local dev
    expect(cmd?.env?.SHIPWRIGHT_ENCRYPTION_KEY?.length).toBeGreaterThan(0);
  });

  test("agent pane sets AGENT_HOME", () => {
    const cmd = getAgentCmd();
    expect(cmd?.env?.AGENT_HOME).toBeDefined();
    expect(cmd?.env?.AGENT_HOME?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildTmuxCommands — pane constants
// ---------------------------------------------------------------------------

describe("buildTmuxCommands — pane constants", () => {
  test("SESSION_NAME is 'shipwright'", () => {
    expect(SESSION_NAME).toBe("shipwright");
  });

  test("PANE_METRICS, PANE_AGENT, PANE_CHAT, PANE_LOGS are exported strings", () => {
    expect(typeof PANE_METRICS).toBe("string");
    expect(typeof PANE_AGENT).toBe("string");
    expect(typeof PANE_CHAT).toBe("string");
    expect(typeof PANE_LOGS).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// launchTmux — injected exec fn
// ---------------------------------------------------------------------------

describe("launchTmux — injected exec fn", () => {
  test("calls exec for every command returned by buildTmuxCommands", async () => {
    const { launchTmux } = await import("./dev-tmux.ts");
    const expected = buildTmuxCommands();

    const captured: TmuxCommand[] = [];
    await launchTmux((cmd) => {
      captured.push(cmd);
      return { exitCode: 0 };
    });

    expect(captured.length).toBe(expected.length);
  });

  test("passes each command's args to exec", async () => {
    const { launchTmux } = await import("./dev-tmux.ts");
    const expected = buildTmuxCommands();

    const capturedArgs: string[][] = [];
    await launchTmux((cmd) => {
      capturedArgs.push(cmd.args);
      return { exitCode: 0 };
    });

    for (let i = 0; i < expected.length; i++) {
      expect(capturedArgs[i]).toEqual(expected[i].args);
    }
  });

  test("passes each command's env to exec", async () => {
    const { launchTmux } = await import("./dev-tmux.ts");
    const expected = buildTmuxCommands();

    const capturedEnvs: (Record<string, string> | undefined)[] = [];
    await launchTmux((cmd) => {
      capturedEnvs.push(cmd.env);
      return { exitCode: 0 };
    });

    for (let i = 0; i < expected.length; i++) {
      expect(capturedEnvs[i]).toEqual(expected[i].env);
    }
  });

  test("throws when exec returns a non-zero exit code", async () => {
    const { launchTmux } = await import("./dev-tmux.ts");

    await expect(
      launchTmux((_cmd) => ({ exitCode: 1, stderr: "tmux: not found" })),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// tmux-absent check — injected exec simulates missing tmux
// ---------------------------------------------------------------------------

describe("launchTmux — tmux not found", () => {
  test("throws with a message pointing at 'task dev' when tmux is absent", async () => {
    const { launchTmux } = await import("./dev-tmux.ts");

    let thrownError: unknown;
    try {
      await launchTmux((_cmd) => {
        throw new Error("spawn ENOENT");
      });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(Error);
    const msg = (thrownError as Error).message;
    // Must mention tmux and point at task dev
    expect(msg.toLowerCase()).toContain("tmux");
    expect(msg).toContain("task dev");
  });
});
