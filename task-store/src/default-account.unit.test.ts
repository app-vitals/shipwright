import { describe, expect, it } from "bun:test";
import { DEFAULT_ACCOUNT_ID } from "./default-account.ts";

describe("DEFAULT_ACCOUNT_ID", () => {
  it("is the literal 'default' matching the migration's column default", () => {
    expect(DEFAULT_ACCOUNT_ID).toBe("default");
  });
});
