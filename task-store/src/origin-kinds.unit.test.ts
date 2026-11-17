/**
 * task-store/src/origin-kinds.unit.test.ts
 *
 * Contract test (PLU-2.5): the write validator and the filter validator read
 * the SAME origin-kind list, so a value a row can hold is always a value
 * `GET /tasks?originKind=` accepts. Adding a kind is a one-place change.
 */

import { describe, expect, it } from "bun:test";
import { BadRequestError } from "./errors.ts";
import { TaskListQuerySchema } from "./openapi-schemas.ts";
import { isOriginKind, ORIGIN_KINDS } from "./origin-kinds.ts";
import { assertTaskFieldTypes } from "./routes/tasks.ts";

describe("origin-kind registry contract", () => {
  it("registers exactly document, skill, cron, human", () => {
    expect([...ORIGIN_KINDS]).toEqual(["document", "skill", "cron", "human"]);
  });

  it("the filter validator accepts exactly the registered list", () => {
    const shape = TaskListQuerySchema.shape.originKind;
    for (const kind of ORIGIN_KINDS) {
      expect(shape.safeParse(kind).success).toBe(true);
    }
    expect(shape.safeParse("bogus").success).toBe(false);
  });

  it("the write validator accepts exactly the registered list", () => {
    for (const kind of ORIGIN_KINDS) {
      expect(() => assertTaskFieldTypes({ originKind: kind })).not.toThrow();
    }
    expect(() => assertTaskFieldTypes({ originKind: null })).not.toThrow();
    expect(() => assertTaskFieldTypes({ originKind: "bogus" })).toThrow(
      BadRequestError,
    );
  });

  it("write and filter agree on every candidate value", () => {
    const candidates = [...ORIGIN_KINDS, "bogus", "", "CRON", "cron "];
    for (const v of candidates) {
      let writeOk = true;
      try {
        assertTaskFieldTypes({ originKind: v });
      } catch {
        writeOk = false;
      }
      const filterOk =
        TaskListQuerySchema.shape.originKind.safeParse(v).success;
      expect(writeOk).toBe(filterOk);
      expect(isOriginKind(v)).toBe(filterOk);
    }
  });
});
