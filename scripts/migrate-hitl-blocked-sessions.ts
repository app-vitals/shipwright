#!/usr/bin/env bun
/**
 * scripts/migrate-hitl-blocked-sessions.ts
 *
 * Migrate blocked sessions (CLA, SHI, ALM) to HITL support.
 *
 * After HIT-1.2 ships (hitl label exists), this script migrates existing
 * blocked tasks that were manually blocked as a workaround for missing HITL
 * support. For each:
 *   - Set hitl: true (mark as requiring human intervention)
 *   - Reset status to pending (allow readiness evaluation to pick it up)
 *   - Clear blockedReason (the HITL flag is now the formal reason for blocking)
 *
 * For downstream dependents that are blocked ONLY because the workaround
 * blocker exists, reset them to pending (dependency mechanism will gate them
 * naturally).
 *
 * Tasks to migrate (set hitl=true, status=pending, clear blockedReason):
 *   - CLA-1.2 (provision CHANGELOG_PAT — UI-only, 30 seconds)
 *   - SHI-1.1 (Terraform Cloud SQL)
 *   - SHI-2.1 (Helm shipwright deployment)
 *   - ALM-4.1 (prod reconcile-k8s verification)
 *
 * Tasks to reset to pending (clear blocked state from workaround):
 *   - CLA-2.1 (depends on CLA-1.2; once CLA-1.2 is HITL, CLA-2.1 can be pending)
 *
 * Tasks to LEAVE UNCHANGED (deferred by Dave — organizational decision, not HITL):
 *   - ALM-1.3
 *   - ALM-3.3
 *   - ALM-4.2
 *   - ALM-4.3
 *
 * This script is idempotent: re-running it is safe. If a task is already
 * migrated, the update will be a no-op.
 *
 * Usage:
 *   bun scripts/migrate-hitl-blocked-sessions.ts [--dry-run] [--verbose]
 *
 * Environment:
 *   GH_TOKEN       GitHub token for gh CLI (required if using GitHub backend)
 *   SHIPWRIGHT_CONFIG  Path to .shipwright.json (defaults to cwd)
 */

import { spawn } from "node:child_process";

const MIGRATIONS = [
  {
    id: "CLA-1.2",
    description: "provision CHANGELOG_PAT — UI-only, 30 seconds",
    changes: { hitl: "true", status: "pending", blockedReason: "" },
  },
  {
    id: "CLA-2.1",
    description: "depends on CLA-1.2; reset to pending when blocker is HITL",
    changes: { status: "pending", blockedReason: "" },
  },
  {
    id: "SHI-1.1",
    description: "Terraform Cloud SQL",
    changes: { hitl: "true", status: "pending", blockedReason: "" },
  },
  {
    id: "SHI-2.1",
    description: "Helm shipwright deployment",
    changes: { hitl: "true", status: "pending", blockedReason: "" },
  },
  {
    id: "ALM-4.1",
    description: "prod reconcile-k8s verification",
    changes: { hitl: "true", status: "pending", blockedReason: "" },
  },
];

const UNCHANGED = [
  "ALM-1.3",
  "ALM-3.3",
  "ALM-4.2",
  "ALM-4.3",
];

const TASK_STORE_SCRIPT = "plugins/shipwright/scripts/task_store.ts";

interface TaskStoreOutput {
  id: string;
  status?: string;
  blockedReason?: string | null;
  hitl?: boolean | null;
  [key: string]: unknown;
}

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function verbose(msg: string, verboseFlag: boolean): void {
  if (verboseFlag) {
    log(`  ${msg}`);
  }
}

async function runTaskStore(
  args: string[],
  verboseFlag: boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [TASK_STORE_SCRIPT, ...args], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`task_store.ts exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

async function queryTask(
  id: string,
  verboseFlag: boolean,
): Promise<TaskStoreOutput | null> {
  try {
    verbose(`Querying ${id}...`, verboseFlag);
    const output = await runTaskStore(["query", "--id", id], verboseFlag);
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed[0];
    }
    return null;
  } catch (e) {
    log(`Error querying ${id}: ${String(e)}`);
    return null;
  }
}

async function updateTask(
  id: string,
  changes: Record<string, string>,
  dryRun: boolean,
  verboseFlag: boolean,
): Promise<boolean> {
  const setArgs = Object.entries(changes).map(
    ([key, value]) => `${key}=${value}`,
  );

  try {
    verbose(
      `${dryRun ? "[DRY RUN] " : ""}Updating ${id} with: ${setArgs.join(", ")}`,
      verboseFlag,
    );

    if (dryRun) {
      return true;
    }

    const args = ["update", "--id", id];
    for (const arg of setArgs) {
      args.push("--set", arg);
    }

    await runTaskStore(args, verboseFlag);
    return true;
  } catch (e) {
    log(`Error updating ${id}: ${String(e)}`);
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const verboseFlag = args.includes("--verbose");

  log("");
  log("=========================================================");
  log("HIT-5.1: Migrate blocked sessions (CLA, SHI, ALM) to HITL");
  log("=========================================================");
  log("");

  if (dryRun) {
    log("[DRY RUN MODE] — no changes will be made");
    log("");
  }

  // Verify task_store.ts exists
  if (!process.cwd().includes("shipwright")) {
    log("Warning: cwd does not appear to be the shipwright repo");
  }

  log("Phase 1: Pre-check — verify tasks exist and current state");
  log("");

  const preMigration: Record<string, TaskStoreOutput> = {};
  for (const { id } of MIGRATIONS) {
    const task = await queryTask(id, verboseFlag);
    if (task) {
      preMigration[id] = task;
      log(
        `✓ ${id}: status=${task.status}, hitl=${task.hitl ?? "null"}, blockedReason=${task.blockedReason ? `"${task.blockedReason}"` : "null"}`,
      );
    } else {
      log(`✗ ${id}: NOT FOUND (task store query returned null)`);
    }
  }

  log("");
  log("Unchanged tasks (pre-check only, should remain as-is):");
  log("");
  const preUnchanged: Record<string, TaskStoreOutput> = {};
  for (const id of UNCHANGED) {
    const task = await queryTask(id, verboseFlag);
    if (task) {
      preUnchanged[id] = task;
      log(
        `✓ ${id}: status=${task.status}, blockedReason=${task.blockedReason ? `"${task.blockedReason}"` : "null"}`,
      );
    } else {
      log(`⊘ ${id}: not found (acceptable if cancelled/removed)`);
    }
  }

  log("");
  log("Phase 2: Migrate tasks");
  log("");

  const migrated: Record<string, boolean> = {};
  for (const { id, description, changes } of MIGRATIONS) {
    const before = preMigration[id];
    if (!before) {
      log(`⊘ ${id}: skipped (not found in pre-check)`);
      continue;
    }

    log(`Migrating ${id} (${description})`);
    const success = await updateTask(id, changes, dryRun, verboseFlag);
    migrated[id] = success;

    if (success) {
      log("  ✓ Updated");
    } else {
      log("  ✗ Failed");
    }
  }

  log("");
  log("Phase 3: Post-check — verify migration results");
  log("");

  const postMigration: Record<string, TaskStoreOutput> = {};
  let allSuccess = true;
  for (const { id } of MIGRATIONS) {
    if (!migrated[id]) {
      log(`⊘ ${id}: skipped (pre-check failed)`);
      continue;
    }

    const task = await queryTask(id, verboseFlag);
    if (task) {
      postMigration[id] = task;
      const hitlOk = task.hitl === true || id === "CLA-2.1"; // CLA-2.1 doesn't need hitl
      const statusOk = task.status === "pending";
      const reasonOk = !task.blockedReason;

      const ok = hitlOk && statusOk && reasonOk;
      const marker = ok ? "✓" : "✗";

      log(
        `${marker} ${id}: status=${task.status}${statusOk ? "" : " [MISMATCH]"}, hitl=${task.hitl ?? "null"}${hitlOk ? "" : " [MISMATCH]"}, blockedReason=${task.blockedReason ? `"${task.blockedReason}" [MISMATCH]` : "null"}`,
      );

      if (!ok) {
        allSuccess = false;
      }
    } else {
      log(`✗ ${id}: post-check failed (query returned null)`);
      allSuccess = false;
    }
  }

  log("");
  log("Unchanged tasks (post-check — should not have changed):");
  log("");
  for (const id of UNCHANGED) {
    const before = preUnchanged[id];
    const after = await queryTask(id, verboseFlag);

    if (!before) {
      log(`⊘ ${id}: not found in pre-check, skipping post-check`);
      continue;
    }

    if (!after) {
      log(`✗ ${id}: disappeared during migration (error?)`);
      allSuccess = false;
      continue;
    }

    const unchanged =
      before.status === after.status &&
      before.blockedReason === after.blockedReason &&
      before.hitl === after.hitl;
    const marker = unchanged ? "✓" : "✗";

    log(
      `${marker} ${id}: status=${after.status}${unchanged ? "" : " [CHANGED]"}, blockedReason=${after.blockedReason ? `"${after.blockedReason}"` : "null"}`,
    );

    if (!unchanged) {
      allSuccess = false;
    }
  }

  log("");
  log("=========================================================");
  if (dryRun) {
    log("DRY RUN COMPLETE");
  } else if (allSuccess) {
    log("MIGRATION SUCCESSFUL ✓");
  } else {
    log("MIGRATION INCOMPLETE — Some tasks did not migrate correctly");
    process.exit(1);
  }
  log("=========================================================");
  log("");
}

main().catch((e) => {
  log(`Fatal error: ${String(e)}`);
  process.exit(1);
});
