import { describe, expect, it } from "bun:test";
import { resolvePublicRepo } from "./main.ts";

// resolvePublicRepo is the pure env rule wired into main.ts startServer():
// it sources SHIPWRIGHT_ADMIN_PUBLIC_REPO and feeds createAdminUIApp's
// publicRepo option, which gates the unauthenticated GET /public/tasks board.
// Tested without touching process.env.
describe("resolvePublicRepo", () => {
  it("returns the repo slug when set", () => {
    expect(
      resolvePublicRepo({
        SHIPWRIGHT_ADMIN_PUBLIC_REPO: "app-vitals/shipwright",
      }),
    ).toBe("app-vitals/shipwright");
  });

  it("returns undefined when unset (board stays in degraded mode)", () => {
    expect(resolvePublicRepo({})).toBeUndefined();
  });

  it("treats an empty string as unset", () => {
    expect(
      resolvePublicRepo({ SHIPWRIGHT_ADMIN_PUBLIC_REPO: "" }),
    ).toBeUndefined();
  });

  it("treats whitespace-only as unset rather than an empty repo filter", () => {
    expect(
      resolvePublicRepo({ SHIPWRIGHT_ADMIN_PUBLIC_REPO: "   " }),
    ).toBeUndefined();
  });

  it("trims surrounding whitespace from a valid value", () => {
    expect(
      resolvePublicRepo({
        SHIPWRIGHT_ADMIN_PUBLIC_REPO: "  app-vitals/shipwright  ",
      }),
    ).toBe("app-vitals/shipwright");
  });
});
