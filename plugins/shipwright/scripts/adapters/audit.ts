/**
 * plugins/shipwright/scripts/adapters/audit.ts
 *
 * Pure, I/O-free audit check functions for task integrity.
 * All functions are synchronous, pure, and suitable for validation pipelines.
 */

import type { Task } from "../store";

/**
 * Result of an audit check.
 *
 * level: 'ok' when check passes, 'warn' for non-blocking issues, 'fail' for blocking issues
 * check: machine-readable check identifier (e.g. 'duplicate-ids')
 * message: human-readable message explaining the result
 */
export interface AuditResult {
  level: "ok" | "warn" | "fail";
  check: string;
  message: string;
}

/**
 * Check for duplicate task IDs.
 *
 * Returns a single 'ok' result if no duplicates exist.
 * Returns one 'fail' result per duplicated ID, including count of occurrences.
 *
 * @param tasks Task array to check
 * @returns Array of AuditResult objects
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

/**
 * Check for dangling task dependencies.
 *
 * For each task, ensures all dependency IDs are in the allKnownIds set.
 * Returns a single 'ok' result if all dependencies resolve.
 * Returns one 'fail' result per dangling dependency reference.
 *
 * @param tasks Task array to check
 * @param allKnownIds Set of all known task IDs in the system
 * @returns Array of AuditResult objects
 */
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
 * Check for cross-repo orphaned tasks.
 *
 * For each task with a repo field, verifies it matches the configured repo.
 * Tasks without a repo field are skipped (not considered orphans).
 * Returns a single 'ok' result if all tasks match or have no repo field.
 * Returns one 'warn' result per task with a mismatched repo.
 *
 * @param tasks Task array to check
 * @param configuredRepo The expected repo in 'owner/repo' format
 * @returns Array of AuditResult objects
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
