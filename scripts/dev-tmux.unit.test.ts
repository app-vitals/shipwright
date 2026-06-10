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
  ADMIN_DEV_LOGIN_URL,
  ADMIN_PORT,
  AGENT_PORT,
  DASHBOARD_URL,
  METRICS_PORT,
  type Pane,
  SESSION_NAME,
  STACK_PANES,
  brewFormulaInstalled,
  buildLogsBanner,
  buildStackCommands,
  dbReachable,
  missingWorkspaceDeps,
  planPostgresSetup,
  runStack,
  sessionExists,
  sessionExistsMessage,
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

  test("enables mouse mode scoped to the session (drag-to-resize)", () => {
    const cmds = buildStackCommands(STACK_PANES);
    const mouse = cmds.find(
      (c) => c.kind === "set-option" && c.argv.includes("mouse"),
    );
    expect(mouse?.argv).toEqual([
      "set-option",
      "-t",
      SESSION_NAME,
      "mouse",
      "on",
    ]);
    // session-scoped, not global — must not touch the user's tmux config
    expect(mouse?.argv).not.toContain("-g");
  });

  test("enables a titled top pane border, session-scoped", () => {
    const cmds = buildStackCommands(STACK_PANES);
    const status = cmds.find(
      (c) => c.kind === "set-option" && c.argv.includes("pane-border-status"),
    );
    expect(status?.argv).toEqual([
      "set-option",
      "-w",
      "-t",
      SESSION_NAME,
      "pane-border-status",
      "top",
    ]);
    // window-scoped (`-w`) but not global (`-g`) — must not touch user config
    expect(status?.argv).not.toContain("-g");
  });

  test("border format renders each pane's title", () => {
    const cmds = buildStackCommands(STACK_PANES);
    const format = cmds.find(
      (c) => c.kind === "set-option" && c.argv.includes("pane-border-format"),
    );
    expect(format?.argv.at(-1)).toBe(" #{pane_title} ");
  });

  test("titles every pane with its label", () => {
    const cmds = buildStackCommands(STACK_PANES);
    const titled = cmds.filter(
      (c) => c.kind === "select-pane" && c.argv.includes("-T"),
    );
    // one title command per pane, carrying that pane's label
    const titles = titled.map((c) => c.argv.at(-1));
    expect(titles).toEqual(STACK_PANES.map((p) => p.label));
  });

  test("uses a single window with 5 panes (1 new-session + 4 split-window)", () => {
    const cmds = buildStackCommands(STACK_PANES);
    const newSessions = cmds.filter((c) => c.argv[0] === "new-session");
    const splits = cmds.filter((c) => c.argv[0] === "split-window");
    expect(newSessions.length).toBe(1);
    expect(splits.length).toBe(4);
  });

  test("runs the migration preflight BEFORE the admin pane is started", () => {
    const cmds = buildStackCommands(STACK_PANES);
    const preflightIdx = cmds.findIndex((c) =>
      c.argv.join(" ").includes("migrate deploy"),
    );
    const adminSendKeysIdx = cmds.findIndex(
      (c) =>
        c.argv[0] === "send-keys" &&
        c.argv.some((a) => a.includes("admin/src/main.ts")),
    );
    expect(preflightIdx).toBeGreaterThanOrEqual(0);
    expect(adminSendKeysIdx).toBeGreaterThanOrEqual(0);
    expect(preflightIdx).toBeLessThan(adminSendKeysIdx);
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
  test("metrics pane runs the metrics server in sqlite mode with METRICS_DB_PATH", () => {
    const { calls, exec } = makeRecorder();
    runStack(STACK_PANES, exec);
    const sk = sendKeysForPane(calls, 0);
    expect(sk?.join(" ")).toContain("metrics/src/server.ts");
    expect(sk?.join(" ")).toContain("METRICS_DB_PATH=state/metrics.db");
    expect(sk?.join(" ")).not.toContain("METRICS_OFFLINE=true");
  });

  test("admin pane (pane 1) runs admin/src/main.ts with PORT=3001 and DATABASE_URL_SHIPWRIGHT_ADMIN", () => {
    const { calls, exec } = makeRecorder();
    runStack(STACK_PANES, exec);
    const sk = sendKeysForPane(calls, 1)?.join(" ") ?? "";
    expect(sk).toContain("admin/src/main.ts");
    expect(sk).toContain(`PORT=${ADMIN_PORT}`);
    expect(sk).toContain("DATABASE_URL_SHIPWRIGHT_ADMIN=");
  });

  test("agent pane (pane 2) runs docker container with SHIPWRIGHT_API_URL via host.docker.internal", () => {
    const { calls, exec } = makeRecorder();
    runStack(STACK_PANES, exec);
    const sk = sendKeysForPane(calls, 2)?.join(" ") ?? "";
    expect(sk).toContain("docker run");
    expect(sk).not.toContain("agent/src/run-agent.ts");
    expect(sk).toContain(`PORT=${AGENT_PORT}`);
    expect(sk).toContain("SHIPWRIGHT_DEV_CHAT=true");
    expect(sk).toContain(`POSTHOG_HOST=http://host.docker.internal:${METRICS_PORT}`);
    expect(sk).toContain("POSTHOG_PROJECT_API_KEY=");
    expect(sk).toContain(
      `SHIPWRIGHT_API_URL=http://host.docker.internal:${ADMIN_PORT}`,
    );
    // container is isolated — no direct DB access
    expect(sk).not.toContain("DATABASE_URL=");
  });

  test("chat pane (pane 3) runs scripts/chat.ts", () => {
    const { calls, exec } = makeRecorder();
    runStack(STACK_PANES, exec);
    const sk = sendKeysForPane(calls, 3)?.join(" ") ?? "";
    expect(sk).toContain("scripts/chat.ts");
  });

  test("logs pane (pane 4) is a scratch shell (no server command)", () => {
    const logs = STACK_PANES[4];
    expect(logs.label).toBe("logs");
    // scratch shell: no long-running bun server entry
    expect(logs.cmd.join(" ")).not.toContain("server.ts");
    expect(logs.cmd.join(" ")).not.toContain("run-agent.ts");
  });

  test("logs pane (pane 4) prints a signpost banner then drops into a shell", () => {
    const cmd = STACK_PANES[4].cmd.join(" ");
    expect(cmd).toContain(DASHBOARD_URL); // tells the user where the UI is
    expect(cmd).toContain(`localhost:${AGENT_PORT}`);
    expect(cmd).toContain('exec "$SHELL"'); // remains an interactive scratch shell
  });

  test("logs banner includes admin service URL", () => {
    const banner = buildLogsBanner();
    expect(banner).toContain(`localhost:${ADMIN_PORT}`);
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
  test("agent pane dummy keys look like dev placeholders (embedded in docker run cmd)", () => {
    const agent = STACK_PANES.find((p) => p.label === "agent") as Pane;
    // All env is embedded in docker run -e flags within cmd, not in pane.env
    const cmdStr = agent.cmd.join(" ");
    expect(cmdStr).toContain("phc_dev_dummy");
    // 64-hex dummy encryption key not needed on thin agent — it's in admin
    // agent must have SHIPWRIGHT_API_URL pointing at host.docker.internal
    expect(cmdStr).toContain("host.docker.internal");
  });

  test("admin pane has DATABASE_URL_SHIPWRIGHT_ADMIN with postgresql scheme", () => {
    const admin = STACK_PANES.find((p) => p.label === "admin") as Pane;
    expect(admin.env?.DATABASE_URL_SHIPWRIGHT_ADMIN).toContain("postgresql:");
    // 64-hex dummy encryption key
    expect(admin.env?.SHIPWRIGHT_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
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

// ---------------------------------------------------------------------------
// Docker agent stack — new tests (additive)
// ---------------------------------------------------------------------------

describe("metrics pane — sqlite mode", () => {
  test("metrics pane runs in sqlite mode with METRICS_DB_PATH (no METRICS_OFFLINE)", () => {
    const metrics = STACK_PANES.find((p) => p.label === "metrics") as Pane;
    expect(metrics.env?.METRICS_OFFLINE).toBeUndefined();
    expect(metrics.env?.METRICS_DB_PATH).toBe("state/metrics.db");
  });
});

describe("admin pane — dev auth + internal key", () => {
  test("admin pane has ADMIN_DEV_AUTH=true", () => {
    const admin = STACK_PANES.find((p) => p.label === "admin") as Pane;
    expect(admin.env?.ADMIN_DEV_AUTH).toBe("true");
  });

  test("admin pane has SHIPWRIGHT_INTERNAL_API_KEY", () => {
    const admin = STACK_PANES.find((p) => p.label === "admin") as Pane;
    expect(admin.env?.SHIPWRIGHT_INTERNAL_API_KEY).toBeDefined();
    expect(admin.env?.SHIPWRIGHT_INTERNAL_API_KEY?.length).toBeGreaterThan(0);
  });

  // A zero-length HS256 secret makes Web Crypto throw "DataError" the moment
  // the admin service signs a session cookie — the service boots green but 500s
  // on first login. The dev stack must inject a non-empty secret.
  test("admin pane has a non-empty SHIPWRIGHT_SESSION_SECRET", () => {
    const admin = STACK_PANES.find((p) => p.label === "admin") as Pane;
    expect(admin.env?.SHIPWRIGHT_SESSION_SECRET).toBeDefined();
    expect(admin.env?.SHIPWRIGHT_SESSION_SECRET?.length).toBeGreaterThan(0);
  });
});

describe("agent pane — docker run", () => {
  test("agent pane runs docker run (not bun run-agent.ts)", () => {
    const agent = STACK_PANES.find((p) => p.label === "agent") as Pane;
    expect(agent.cmd[0]).toBe("docker");
    expect(agent.cmd[1]).toBe("run");
    expect(agent.cmd.join(" ")).not.toContain("run-agent.ts");
  });

  test("agent pane docker run includes port -p 3000:3000", () => {
    const agent = STACK_PANES.find((p) => p.label === "agent") as Pane;
    const cmdStr = agent.cmd.join(" ");
    expect(cmdStr).toContain("-p 3000:3000");
  });

  test("agent pane docker run mounts named volume shipwright-agent-home at /data/agent-home", () => {
    const agent = STACK_PANES.find((p) => p.label === "agent") as Pane;
    const cmdStr = agent.cmd.join(" ");
    expect(cmdStr).toContain("shipwright-agent-home:/data/agent-home");
  });

  test("agent pane docker run passes SHIPWRIGHT_DEV_CHAT=true via -e flag", () => {
    const agent = STACK_PANES.find((p) => p.label === "agent") as Pane;
    const cmdStr = agent.cmd.join(" ");
    expect(cmdStr).toContain("SHIPWRIGHT_DEV_CHAT=true");
  });

  test("agent pane docker run passes SHIPWRIGHT_LOCAL_MARKETPLACE=/repo/plugins/shipwright", () => {
    const agent = STACK_PANES.find((p) => p.label === "agent") as Pane;
    const cmdStr = agent.cmd.join(" ");
    expect(cmdStr).toContain(
      "SHIPWRIGHT_LOCAL_MARKETPLACE=/repo/plugins/shipwright",
    );
  });

  test("agent pane docker run passes SHIPWRIGHT_API_URL pointing at host.docker.internal", () => {
    const agent = STACK_PANES.find((p) => p.label === "agent") as Pane;
    const cmdStr = agent.cmd.join(" ");
    expect(cmdStr).toContain(
      `SHIPWRIGHT_API_URL=http://host.docker.internal:${ADMIN_PORT}`,
    );
  });

  test("agent pane docker run passes POSTHOG_HOST pointing at host.docker.internal", () => {
    const agent = STACK_PANES.find((p) => p.label === "agent") as Pane;
    const cmdStr = agent.cmd.join(" ");
    expect(cmdStr).toContain(
      `POSTHOG_HOST=http://host.docker.internal:${METRICS_PORT}`,
    );
  });

  test("agent pane cmd has no inline env (all env in -e flags within cmd)", () => {
    const agent = STACK_PANES.find((p) => p.label === "agent") as Pane;
    // env field should be empty / undefined — all env is embedded in docker run -e flags
    const envKeys = Object.keys(agent.env ?? {});
    expect(envKeys.length).toBe(0);
  });

  test("agent pane docker run loads state/dev-agent.env via --env-file", () => {
    // Secrets (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY) must NOT be hardcoded
    // in the pane definition — they are injected via the developer's local env file.
    const agent = STACK_PANES.find((p) => p.label === "agent") as Pane;
    const cmdStr = agent.cmd.join(" ");
    expect(cmdStr).toContain("--env-file state/dev-agent.env");
  });
});

describe("buildStackCommands — docker build + seed preflights", () => {
  test("buildStackCommands includes docker build preflight before agent pane", () => {
    const cmds = buildStackCommands(STACK_PANES, {
      repoPath: "/fake/repo",
    });
    const dockerBuildIdx = cmds.findIndex((c) =>
      c.argv.join(" ").includes("docker build"),
    );
    const agentSendKeysIdx = cmds.findIndex(
      (c) =>
        c.kind === "send-keys" &&
        c.argv.some((a) => a.includes(`${SESSION_NAME}:0.2`)),
    );
    expect(dockerBuildIdx).toBeGreaterThanOrEqual(0);
    expect(agentSendKeysIdx).toBeGreaterThanOrEqual(0);
    expect(dockerBuildIdx).toBeLessThan(agentSendKeysIdx);
  });

  test("docker build preflight builds the agent image with correct tag and Dockerfile", () => {
    const cmds = buildStackCommands(STACK_PANES, {
      repoPath: "/fake/repo",
    });
    const dockerBuild = cmds.find((c) =>
      c.argv.join(" ").includes("docker build"),
    );
    expect(dockerBuild).toBeDefined();
    expect(dockerBuild?.kind).toBe("preflight");
    const cmdStr = dockerBuild?.argv.join(" ") ?? "";
    expect(cmdStr).toContain("shipwright-agent-dev");
    expect(cmdStr).toContain("agent/Dockerfile");
  });

  test("buildStackCommands includes seed preflight after migrate and before agent pane", () => {
    const cmds = buildStackCommands(STACK_PANES, {
      repoPath: "/fake/repo",
    });
    const migrateIdx = cmds.findIndex((c) =>
      c.argv.join(" ").includes("migrate deploy"),
    );
    const seedIdx = cmds.findIndex((c) =>
      c.argv.join(" ").includes("seed-dev-agent"),
    );
    const agentSendKeysIdx = cmds.findIndex(
      (c) =>
        c.kind === "send-keys" &&
        c.argv.some((a) => a.includes(`${SESSION_NAME}:0.2`)),
    );
    expect(seedIdx).toBeGreaterThanOrEqual(0);
    expect(migrateIdx).toBeGreaterThanOrEqual(0);
    expect(agentSendKeysIdx).toBeGreaterThanOrEqual(0);
    expect(migrateIdx).toBeLessThan(seedIdx);
    expect(seedIdx).toBeLessThan(agentSendKeysIdx);
  });

  test("seed preflight uses bun to run seed-dev-agent.ts", () => {
    const cmds = buildStackCommands(STACK_PANES, {
      repoPath: "/fake/repo",
    });
    const seed = cmds.find((c) =>
      c.argv.join(" ").includes("seed-dev-agent"),
    );
    expect(seed).toBeDefined();
    expect(seed?.kind).toBe("preflight");
    const cmdStr = seed?.argv.join(" ") ?? "";
    expect(cmdStr).toContain("bun");
    expect(cmdStr).toContain("seed-dev-agent.ts");
  });

  test("docker run in agent pane uses repoPath for the host volume mount", () => {
    const cmds = buildStackCommands(STACK_PANES, {
      repoPath: "/fake/repo",
    });
    const agentSendKeys = cmds.find(
      (c) =>
        c.kind === "send-keys" &&
        c.argv.some((a) => a.includes(`${SESSION_NAME}:0.2`)),
    );
    const shellLine = agentSendKeys?.argv.join(" ") ?? "";
    expect(shellLine).toContain("/fake/repo:/repo:ro");
  });

  test("docker run has exactly two -v mounts (agent-home volume + repo read-only)", () => {
    // Isolation: only the named volume and the repo are bound — host home dir is never mounted.
    const cmds = buildStackCommands(STACK_PANES, { repoPath: "/fake/repo" });
    const agentSendKeys = cmds.find(
      (c) =>
        c.kind === "send-keys" &&
        c.argv.some((a) => a.includes(`${SESSION_NAME}:0.2`)),
    );
    const shellLine = agentSendKeys?.argv.join(" ") ?? "";
    // Exactly the named volume and the read-only repo — no host home paths.
    const volumeMatches = shellLine.match(/-v\s+\S+/g) ?? [];
    expect(volumeMatches.length).toBe(2);
    expect(shellLine).not.toContain("/root");
    expect(shellLine).not.toContain("/home");
  });
});

describe("ADMIN_DEV_LOGIN_URL", () => {
  test("ADMIN_DEV_LOGIN_URL is exported and points to admin port /admin/dev-login", () => {
    expect(ADMIN_DEV_LOGIN_URL).toBe(
      `http://localhost:${ADMIN_PORT}/admin/dev-login`,
    );
  });
});
