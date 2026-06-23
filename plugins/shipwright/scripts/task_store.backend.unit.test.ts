/**
 * plugins/shipwright/scripts/task_store.backend.unit.test.ts
 *
 * Unit tests for the `backend` subcommand helper in task_store.ts.
 */

import { expect, test } from "bun:test";
import { getBackend } from "./task_store";

test("getBackend always returns 'task-store'", () => {
  expect(getBackend()).toBe("task-store");
});
