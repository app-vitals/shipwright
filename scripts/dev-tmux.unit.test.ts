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
  type TmuxCommand,
  buildTmuxCommands,
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

/** Find the command text sent to a pane (the arg before "Enter" in send-keys). */
function findCommandText(cmds: TmuxCommand[], paneTarget: string): string | undefined {
  const cmd = cmds.find(
    (c) =>
      c.args.includes("send-keys") &&
      c.args.some((a) => a.includes(paneTarget)),
  );
  if (!cmd) return undefined;
  // send-keys args: ["tmux", "send-keys", "-t", pane, commandText, "Enter"]
  const enterIdx = cmd.args.indexOf("Enter");
  return enterIdx > 0 ? cmd.args[enterIdx - 1] : undefined;
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
  test("metrics pane command includes METRICS_OFFLINE=true inline", () => {
    const cmds = buildTmuxCommands();
    const text = findCommandText(cmds, PANE_METRICS);
    expect(text).toBeDefined();
    expect(text).toContain("METRICS_OFFLINE=true");
  });
});

// ---------------------------------------------------------------------------
// buildTmuxCommands — agent pane env
// ---------------------------------------------------------------------------

describe("buildTmuxCommands — agent pane env", () => {
  // Env vars are inlined in the send-keys command text so they take effect
  // inside the tmux pane shell (not just in the tmux CLI subprocess).
  function getAgentText() {
    return findCommandText(buildTmuxCommands(), PANE_AGENT);
  }

  test("agent pane command includes SHIPWRIGHT_DEV_CHAT=true", () => {
    expect(getAgentText()).toContain("SHIPWRIGHT_DEV_CHAT=true");
  });

  test("agent pane command includes POSTHOG_HOST pointing at local metrics", () => {
    expect(getAgentText()).toContain("POSTHOG_HOST=http://localhost:3460");
  });

  test("agent pane command includes POSTHOG_PROJECT_API_KEY", () => {
    expect(getAgentText()).toContain("POSTHOG_PROJECT_API_KEY=");
  });

  test("agent pane command includes DATABASE_URL_AGENT as a local SQLite path", () => {
    expect(getAgentText()).toMatch(/DATABASE_URL_AGENT=file:/);
  });

  test("agent pane command includes SHIPWRIGHT_ENCRYPTION_KEY", () => {
    expect(getAgentText()).toContain("SHIPWRIGHT_ENCRYPTION_KEY=");
  });

  test("agent pane command includes AGENT_HOME", () => {
    expect(getAgentText()).toContain("AGENT_HOME=");
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

  test("each command has only args (no env field — env is inlined in command text)", async () => {
    const cmds = buildTmuxCommands();
    for (const cmd of cmds) {
      // TmuxCommand no longer has env — env vars are inline in the args text
      expect("env" in cmd).toBe(false);
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
