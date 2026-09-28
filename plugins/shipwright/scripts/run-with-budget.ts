#!/usr/bin/env bun
// Shared enforced, process-group-aware timeout wrapper (LVBS-1.1).
//
// Extracts the `setsid timeout --kill-after=...` pattern duplicated as raw
// inline bash across plugins/shipwright/commands/dev-task.md's Step 8
// ("Enforced, Process-Group-Aware Timeouts") and patch.md's Steps 4b/5b/6c
// into a single shared, standalone script.
//
// This also fixes a live correctness bug in the duplicated snippet. The old
// pattern ran the wrapped command as:
//
//   setsid timeout --kill-after=10s {budget}s {command} &
//   CMD_PID=$!
//   wait $CMD_PID
//   EXIT=$?
//
// Bare `setsid` (without `--wait`/`-w`) forks a new session and returns
// *immediately* — it does not block until the process it started inside
// that session exits. `wait $CMD_PID` therefore captures setsid's own
// near-instant exit, not the wrapped command's, so `EXIT` is a false `0`
// while the real command (`timeout ... {command}`) is still running in the
// background. The subsequent `kill -TERM/-KILL -$CMD_PID` cleanup then
// kills that still-running command mid-flight. Net effect: a check can
// report a clean pass for a command that never actually finished (caught
// live on PR #3653).
//
// This script uses `setsid --wait timeout --kill-after={n}s {budget}s
// {command}` instead — `--wait` makes `setsid` itself block until the
// process tree it started exits, so its own exit code (and the wall-clock
// time to get it) reflects the real outcome. Spawning it directly via
// `Bun.spawn` and awaiting `proc.exited` (rather than bash's `cmd &` plus a
// separate `wait $!`) sidesteps the race outright: there is no second shell
// statement that can observe a stale PID's exit.
//
// `setsid` puts the whole wrapped tree in a new session/process group with
// `setsid`'s own PID as the group leader — confirmed empirically: even with
// `--wait` (which forks internally so `setsid` can stay alive to relay the
// wrapped command's exit status instead of exec'ing it away), the forked
// worker inherits rather than replaces that group, so every descendant —
// `timeout`, the command, and anything it forks — shares `proc.pid` as its
// pgid. That lets `kill -TERM/-KILL -PID` (negative PID) target the whole
// group as a cleanup backstop, run unconditionally after the spawn settles,
// even though `--wait` already makes `proc.exited` trustworthy on its own.
// GNU `timeout` only signals the command it directly execs; a command that
// backgrounds a grandchild (e.g. `sh -c 'sleep 10 & wait'`) can leave that
// grandchild alive after `timeout` reports expiry unless the whole process
// group is killed.
//
// Deliberately has no dependency on @shipwright/lib or any other workspace
// package — plugins/shipwright must stay installable standalone into other
// repos (see plugins/shipwright/CLAUDE.md).
//
// CLI:
//   bun run "${CLAUDE_PLUGIN_ROOT}/scripts/run-with-budget.ts" \
//     --budget 600 --kill-after 10 -- bun test
// Prints `{"status":"pass"|"fail"|"timeout","exitCode":number|null,"durationMs":number}`
// as JSON to stdout so callers can parse with `jq`.

// ─── Types ────────────────────────────────────────────────────────────────────

export type RunWithBudgetStatus = "pass" | "fail" | "timeout";

export interface RunWithBudgetOptions {
  budgetSeconds: number;
  killAfterSeconds: number;
}

export interface RunWithBudgetResult {
  status: RunWithBudgetStatus;
  exitCode: number | null;
  durationMs: number;
}

// ─── runWithBudget ──────────────────────────────────────────────────────────────
//
// Classification (mirrors dev-task.md's Step 8 EXIT classification exactly):
//   - exitCode 0   -> "pass"
//   - exitCode 124 -> "timeout" (GNU `timeout`'s own expiry exit code — this
//     is what it reports by default whether the command was reaped via
//     SIGTERM or (after --kill-after) SIGKILL, since --preserve-status is
//     never passed)
//   - anything else (including null, e.g. the process was killed by a
//     signal outside `timeout`'s own accounting) -> "fail"
function classifyExit(exitCode: number | null): RunWithBudgetStatus {
  if (exitCode === 0) return "pass";
  if (exitCode === 124) return "timeout";
  return "fail";
}

/** Best-effort: the target process group may have already exited cleanly. */
function killProcessGroup(pgid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH (already gone) or EPERM — nothing more we can do here.
  }
}

export async function runWithBudget(
  command: string[],
  opts: RunWithBudgetOptions,
): Promise<RunWithBudgetResult> {
  const { budgetSeconds, killAfterSeconds } = opts;

  const wrapped = [
    "setsid",
    "--wait",
    "timeout",
    `--kill-after=${killAfterSeconds}s`,
    `${budgetSeconds}s`,
    ...command,
  ];

  const start = Date.now();
  const proc = Bun.spawn(wrapped, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  const durationMs = Date.now() - start;

  // Cleanup backstop regardless of outcome — see top comment for why
  // `proc.pid` is the right pgid to target even under `--wait`.
  killProcessGroup(proc.pid, "SIGTERM");
  killProcessGroup(proc.pid, "SIGKILL");

  return { status: classifyExit(exitCode), exitCode, durationMs };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

interface ParsedCliArgs {
  budgetSeconds: number;
  killAfterSeconds: number;
  command: string[];
}

function parseCliArgs(argv: string[]): ParsedCliArgs {
  let budgetSeconds: number | undefined;
  let killAfterSeconds: number | undefined;
  let command: string[] | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--budget") {
      budgetSeconds = Number(argv[++i]);
    } else if (arg === "--kill-after") {
      killAfterSeconds = Number(argv[++i]);
    } else if (arg === "--") {
      command = argv.slice(i + 1);
      break;
    }
  }

  if (budgetSeconds === undefined || Number.isNaN(budgetSeconds)) {
    throw new Error("run-with-budget: --budget {seconds} is required");
  }
  if (killAfterSeconds === undefined || Number.isNaN(killAfterSeconds)) {
    throw new Error("run-with-budget: --kill-after {seconds} is required");
  }
  if (!command || command.length === 0) {
    throw new Error(
      "run-with-budget: a command is required after `--` (e.g. `-- bun test`)",
    );
  }

  return { budgetSeconds, killAfterSeconds, command };
}

if (import.meta.main) {
  const { budgetSeconds, killAfterSeconds, command } = parseCliArgs(
    process.argv.slice(2),
  );
  const result = await runWithBudget(command, {
    budgetSeconds,
    killAfterSeconds,
  });
  console.log(JSON.stringify(result));
  process.exit(result.status === "pass" ? 0 : 1);
}
