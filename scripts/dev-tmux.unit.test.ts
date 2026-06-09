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
  buildStackCommands,
  type Pane,
  runStack,
  SESSION_NAME,
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
    expect(sk).toContain("SHIPWRIGHT_DEV_CHAT=true");
    expect(sk).toContain("POSTHOG_HOST=http://localhost:3460");
    expect(sk).toContain("POSTHOG_PROJECT_API_KEY=");
    expect(sk).toContain("DATABASE_URL_AGENT=");
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
    expect(agent.env?.DATABASE_URL_AGENT).toContain("file:");
  });
});

describe("ports", () => {
  test("agent pane is wired for :3000", () => {
    expect(AGENT_PORT).toBe(3000);
  });
});
