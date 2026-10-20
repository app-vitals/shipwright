import { describe, expect, it } from "bun:test";
import {
  type AdminExtensionContext,
  collectOpenApiContributions,
  resolveAdminExtensions,
} from "./admin-extension.ts";
import { codingAdminExtension } from "./coding-admin-extension.ts";

const ctx = { env: {} } as unknown as AdminExtensionContext;

describe("codingAdminExtension", () => {
  it("is named coding", () => {
    expect(codingAdminExtension.name).toBe("coding");
  });

  it("registers nothing yet: the admin it composes is the bare platform", () => {
    expect(resolveAdminExtensions([codingAdminExtension], ctx)).toEqual(
      resolveAdminExtensions([], ctx),
    );
    expect(collectOpenApiContributions([codingAdminExtension])).toEqual(
      collectOpenApiContributions([]),
    );
  });
});
