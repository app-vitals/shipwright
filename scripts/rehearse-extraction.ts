#!/usr/bin/env bun
/**
 * scripts/rehearse-extraction.ts
 *
 * Extraction rehearsal (AGR-1.7). Runs scripts/extract-platform.ts into a
 * scratch directory (no-history and history mode) and proves the extracted
 * tree is a working repository: frozen install, typecheck, lint, bun test,
 * the import-boundary gate, both Dockerfile builds and the base-image
 * contract smoke test. Run on a schedule so the cut stays ready while the
 * source repository keeps moving; a failing run fails the workflow, which
 * pages through GitHub's normal failed-workflow notification.
 *
 * Usage:
 *   bun scripts/rehearse-extraction.ts [--mode no-history|history|both]
 *     [--source <repo>] [--ref <rev>] [--scratch <dir>] [--keep]
 *     [--skip-docker] [--only <stage,stage>] [--plant-violation]
 *
 * --plant-violation writes a file that imports outside the repository into
 * the extracted tree, to prove the boundary gate (and so the rehearsal) fails.
 * Docker stages run once (first mode); the trees differ only in git history.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { extractPlatform } from "./extract-platform";

export type Mode = "no-history" | "history";

export interface Stage {
  name: string;
  cmd: string[];
  /** Directory to run in, relative to the extracted tree root (default: the root). */
  cwd?: string;
  env?: Record<string, string>;
  docker?: boolean;
}

export interface RehearsalOptions {
  modes: Mode[];
  source: string;
  ref: string;
  scratch: string;
  keep: boolean;
  skipDocker: boolean;
  only: string[] | null;
  plantViolation: boolean;
}

export interface RehearsalFailure {
  mode: Mode;
  stage: string;
  output: string;
}

export const RUNTIME_IMAGE = "agent:rehearsal";
export const ADMIN_IMAGE = "agent-admin:rehearsal";
const TAIL_LINES = 40;

/** Verification stages run in the extracted tree, in order. */
export function planStages(): Stage[] {
  return [
    // The extraction carries no bun.lock (its workspace set differs from the
    // source's), so the source lockfile is seeded and pruned to the extracted
    // workspaces first — this keeps pinned versions (and the patched
    // @slack/socket-mode) instead of re-resolving to latest. The frozen install
    // then proves the pruned lockfile is self-consistent.
    { name: "lock-prune", cmd: ["bun", "install"] },
    { name: "install", cmd: ["bun", "install", "--frozen-lockfile"] },
    { name: "typecheck", cmd: ["bun", "run", "typecheck"] },
    { name: "lint", cmd: ["bun", "run", "lint"] },
    { name: "boundary", cmd: ["bun", "run", "check:boundary"] },
    // Mirrors the extracted CI job (`cd admin && bunx prisma migrate deploy`):
    // the admin tests need the schema applied, and the schema path is relative
    // to admin/.
    {
      name: "db-sync",
      cmd: ["bunx", "prisma", "migrate", "deploy", "--schema=prisma/schema"],
      cwd: "admin",
    },
    { name: "test", cmd: ["bun", "test"], env: { NODE_ENV: "test" } },
    {
      name: "docker-admin",
      cmd: [
        "docker",
        "build",
        "-f",
        "admin/Dockerfile",
        "-t",
        ADMIN_IMAGE,
        ".",
      ],
      docker: true,
    },
    {
      name: "docker-runtime",
      cmd: [
        "docker",
        "build",
        "-f",
        "runtime/Dockerfile",
        "-t",
        RUNTIME_IMAGE,
        ".",
      ],
      docker: true,
    },
    {
      name: "contract-smoke",
      cmd: ["bun", "test", "runtime/base-image-contract.smoke.test.ts"],
      env: { SHIPWRIGHT_CONTRACT_BASE_IMAGE: RUNTIME_IMAGE },
      docker: true,
    },
  ];
}

/** db-sync is only meaningful (and only possible) with a test database configured. */
function skipReason(stage: Stage, opts: RehearsalOptions, dockerPass: boolean) {
  if (stage.name === "db-sync" && !process.env.DATABASE_URL_ADMIN_TEST)
    return "DATABASE_URL_ADMIN_TEST not set";
  if (stage.docker && opts.skipDocker) return "--skip-docker";
  if (stage.docker && !dockerPass) return "already built in an earlier mode";
  return null;
}

function tail(text: string): string {
  return text.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
}

/**
 * The error output printed above each `(fail)` line of a `bun test` run, which
 * the final tail would otherwise cut off (it keeps only the summary). Each
 * block runs from the previous test result line to its own `(fail)` line, and
 * is capped so a mass failure stays readable.
 */
export function failureBlocks(
  output: string,
  maxFailures = 12,
  maxLines = 25,
): string {
  const lines = output.split("\n");
  const blocks: string[] = [];
  let start = 0;
  for (let i = 0; i < lines.length && blocks.length < maxFailures; i++) {
    const line = lines[i] ?? "";
    if (/^\((?:pass|skip|todo)\) /.test(line)) {
      start = i + 1;
    } else if (line.startsWith("(fail) ")) {
      blocks.push(
        lines
          .slice(Math.max(start, i - maxLines), i + 1)
          .join("\n")
          .trim(),
      );
      start = i + 1;
    }
  }
  return blocks.join("\n\n");
}

function failureOutput(text: string): string {
  const blocks = failureBlocks(text);
  return blocks
    ? `${blocks}\n\n--- last ${TAIL_LINES} lines ---\n${tail(text)}`
    : tail(text);
}

// Agent-runtime config the host process may carry (e.g. when the rehearsal runs
// inside a Shipwright agent). Tests read these at import time, so they must not
// leak into the extracted tree's stages — CI never has them set.
const HOST_ENV_PREFIXES = ["AGENT_", "ANTHROPIC_", "SHIPWRIGHT_"];

function cleanEnv(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !HOST_ENV_PREFIXES.some((prefix) => k.startsWith(prefix)),
    ),
  );
}

function runStage(
  stage: Stage,
  cwd: string,
): RehearsalFailure["output"] | null {
  let p: ReturnType<typeof Bun.spawnSync>;
  try {
    p = Bun.spawnSync(stage.cmd, {
      cwd: stage.cwd ? join(cwd, stage.cwd) : cwd,
      env: { ...cleanEnv(), ...stage.env },
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return `could not run ${stage.cmd[0]}: ${(err as Error).message}`;
  }
  if (p.success) return null;
  return failureOutput(`${p.stdout.toString()}\n${p.stderr.toString()}`);
}

/** A file whose import leaves the repository, which the boundary gate must reject. */
function plantViolation(tree: string): void {
  const file = join(tree, "runtime", "rehearsal-planted-violation.ts");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `import { x } from "../../outside-the-repo/missing";\nexport const y = x;\n`,
  );
}

function seedLockfile(opts: RehearsalOptions, tree: string): void {
  const p = Bun.spawnSync(
    ["git", "-C", opts.source, "show", `${opts.ref}:bun.lock`],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (!p.success)
    throw new Error(`cannot read bun.lock: ${p.stderr.toString()}`);
  writeFileSync(join(tree, "bun.lock"), p.stdout);
}

export function rehearse(opts: RehearsalOptions): RehearsalFailure | null {
  let dockerPass = true;
  for (const mode of opts.modes) {
    const out = join(opts.scratch, mode);
    console.log(`\n=== rehearsal: ${mode} ===`);
    try {
      const result = extractPlatform({
        source: opts.source,
        ref: opts.ref,
        out,
        history: mode === "history",
        clean: true,
      });
      console.log(`extracted ${result.files} files from ${result.sha}`);
    } catch (err) {
      return { mode, stage: "extract", output: (err as Error).message };
    }
    try {
      seedLockfile(opts, out);
    } catch (err) {
      return { mode, stage: "lock-seed", output: (err as Error).message };
    }
    if (opts.plantViolation) plantViolation(out);

    for (const stage of planStages()) {
      if (
        opts.only &&
        !opts.only.includes(stage.name) &&
        !(stage.name === "lock-prune" && opts.only.includes("install"))
      )
        continue;
      const skip = skipReason(stage, opts, dockerPass);
      if (skip) {
        console.log(`- ${stage.name}: skipped (${skip})`);
        continue;
      }
      const failure = runStage(stage, out);
      if (failure !== null) return { mode, stage: stage.name, output: failure };
      console.log(`✓ ${stage.name}`);
    }
    dockerPass = false;
  }
  return null;
}

export function formatFailure(f: RehearsalFailure): string {
  return [
    `REHEARSAL FAILED [${f.mode}] stage '${f.stage}'`,
    "The extracted tree is not ready to cut. Last output:",
    "",
    f.output,
  ].join("\n");
}

export function parseArgs(argv: string[]): RehearsalOptions {
  const opts: RehearsalOptions = {
    modes: ["no-history", "history"],
    source: resolve(import.meta.dir, ".."),
    ref: "HEAD",
    scratch: "",
    keep: false,
    skipDocker: false,
    only: null,
    plantViolation: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--mode") {
      const m = value();
      if (m === "both") opts.modes = ["no-history", "history"];
      else if (m === "no-history" || m === "history") opts.modes = [m];
      else throw new Error(`--mode must be no-history, history or both`);
    } else if (arg === "--source") opts.source = value();
    else if (arg === "--ref") opts.ref = value();
    else if (arg === "--scratch") opts.scratch = value();
    else if (arg === "--keep") opts.keep = true;
    else if (arg === "--skip-docker") opts.skipDocker = true;
    else if (arg === "--only") opts.only = value().split(",");
    else if (arg === "--plant-violation") opts.plantViolation = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

if (import.meta.main) {
  let opts: RehearsalOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  const ownScratch = !opts.scratch;
  if (ownScratch) opts.scratch = mkdtempSync(join(tmpdir(), "rehearse-"));
  let failure: RehearsalFailure | null;
  try {
    failure = rehearse(opts);
  } finally {
    if (ownScratch && !opts.keep)
      rmSync(opts.scratch, { recursive: true, force: true });
  }
  if (failure) {
    console.error(formatFailure(failure));
    process.exit(1);
  }
  console.log("\nREHEARSAL PASSED");
}
