import type { Task, TaskStatus } from "../store.ts";

/**
 * Emits console.warn for missing required fields on specific status transitions.
 * Never throws — callers always proceed after calling this.
 *
 * Rules:
 * 1. Transitioning to pr_open: warn if prCreatedAt is absent from merged state
 * 2. Transitioning to pr_open: warn if both pr and prUrl are absent
 * 3. Transitioning from pr_open to approved or merged: warn if ciFixAttempts is absent
 * 4. Transitioning to in_progress: warn if model is absent (soft warning only)
 */
export function warnMissingFields(
  currentStatus: TaskStatus | undefined,
  newStatus: TaskStatus | undefined,
  mergedTask: Partial<Task>,
  warn: (msg: string) => void = console.warn,
): void {
  if (newStatus === "pr_open") {
    if (!mergedTask.prCreatedAt) {
      warn("[shipwright] task transitioning to pr_open is missing prCreatedAt");
    }
    if (mergedTask.pr == null && !mergedTask.prUrl) {
      warn(
        "[shipwright] task transitioning to pr_open is missing both pr and prUrl — at least one is required",
      );
    }
  }

  if (
    currentStatus === "pr_open" &&
    (newStatus === "approved" || newStatus === "merged")
  ) {
    if (mergedTask.ciFixAttempts == null) {
      warn(
        `[shipwright] task transitioning from pr_open to ${newStatus} is missing ciFixAttempts`,
      );
    }
  }

  if (newStatus === "in_progress" && !mergedTask.model) {
    warn(
      "[shipwright] task transitioning to in_progress is missing model field — consider setting model to haiku, sonnet, or opus",
    );
  }
}
