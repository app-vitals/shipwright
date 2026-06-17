/**
 * plugins/shipwright/scripts/adapters/audit.ts
 *
 * Pure, I/O-free audit check functions for task integrity.
 */

import type { Task } from "../store";

export interface AuditResult {
  level: "ok" | "warn" | "fail";
  check: string;
  message: string;
}

/**
 * Detects duplicate task IDs within the provided `tasks` slice.
 * Callers are responsible for passing the full set if cross-scope detection is needed —
 * duplicates that span filtered subsets will not be surfaced.
 */
export function checkDuplicateIds(tasks: Task[]): AuditResult[] {
  const idCounts = new Map<string, number>();

  for (const task of tasks) {
    idCounts.set(task.id, (idCounts.get(task.id) ?? 0) + 1);
  }

  const failures: AuditResult[] = [];
  for (const [id, count] of idCounts.entries()) {
    if (count > 1) {
      failures.push({
        level: "fail",
        check: "duplicate-ids",
        message: `ID '${id}' appears ${count} times in task list`,
      });
    }
  }

  if (failures.length === 0) {
    return [
      {
        level: "ok",
        check: "duplicate-ids",
        message: "No duplicate IDs found",
      },
    ];
  }

  return failures;
}

export function checkDanglingDeps(
  tasks: Task[],
  allKnownIds: Set<string>,
): AuditResult[] {
  const failures: AuditResult[] = [];

  for (const task of tasks) {
    if (!task.dependencies) continue;
    for (const depId of task.dependencies) {
      if (!allKnownIds.has(depId)) {
        failures.push({
          level: "fail",
          check: "dangling-deps",
          message: `Task '${task.id}' depends on unknown ID '${depId}'`,
        });
      }
    }
  }

  if (failures.length === 0) {
    return [
      {
        level: "ok",
        check: "dangling-deps",
        message: "No dangling dependencies",
      },
    ];
  }

  return failures;
}

/**
 * Returns warn for each task whose repo doesn't match configuredRepo.
 * Tasks with no `repo` field are skipped — only explicit mismatches are flagged.
 */
export function checkCrossRepoOrphans(
  tasks: Task[],
  configuredRepo: string,
): AuditResult[] {
  const warnings: AuditResult[] = [];

  for (const task of tasks) {
    if (!task.repo) continue;
    if (task.repo !== configuredRepo) {
      warnings.push({
        level: "warn",
        check: "cross-repo-orphans",
        message: `Task '${task.id}' uses repo '${task.repo}', expected '${configuredRepo}'`,
      });
    }
  }

  if (warnings.length === 0) {
    return [
      {
        level: "ok",
        check: "cross-repo-orphans",
        message: "No cross-repo orphans",
      },
    ];
  }

  return warnings;
}
