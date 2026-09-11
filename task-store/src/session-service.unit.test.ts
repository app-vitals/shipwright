/**
 * task-store/src/session-service.unit.test.ts
 *
 * Pure-logic unit coverage for isBlankSession() — the "is this task.session
 * value absent for the purposes of the Session upsert hook" predicate used
 * by SessionService.upsert(). No I/O; the DB-backed upsert()
 * create/un-archive/no-overwrite behavior is covered by
 * session-service.integration.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { isBlankSession } from "./session-service.ts";

describe("isBlankSession (unit)", () => {
  it("treats null as blank", () => {
    expect(isBlankSession(null)).toBe(true);
  });

  it("treats undefined as blank", () => {
    expect(isBlankSession(undefined)).toBe(true);
  });

  it("treats an empty string as blank", () => {
    expect(isBlankSession("")).toBe(true);
  });

  it("treats a whitespace-only string as blank", () => {
    expect(isBlankSession("   ")).toBe(true);
  });

  it("treats a tab/newline-only string as blank", () => {
    expect(isBlankSession("\t\n  ")).toBe(true);
  });

  it("treats a non-blank string as present", () => {
    expect(isBlankSession("x")).toBe(false);
  });

  it("treats a string with meaningful whitespace around real content as present", () => {
    expect(isBlankSession("  x  ")).toBe(false);
  });
});
