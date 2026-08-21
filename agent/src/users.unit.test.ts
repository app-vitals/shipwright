import { afterEach, describe, expect, it, mock } from "bun:test";
import { clearCache, resolveDisplayName, resolveUserEmail } from "./users.ts";

const makeClient = (profile: Record<string, string | undefined>) => ({
  users: {
    info: mock(async () => ({ user: { profile, name: "fallback" } })),
  },
});

describe("resolveDisplayName", () => {
  afterEach(() => {
    clearCache();
  });

  it("returns display_name when available", async () => {
    const client = makeClient({
      display_name: "Dan",
      real_name: "Dan McAulay",
    });
    expect(await resolveDisplayName("U_DN1", client as never)).toBe("Dan");
  });

  it("falls back to real_name when display_name is empty", async () => {
    const client = makeClient({ display_name: "", real_name: "Dan McAulay" });
    expect(await resolveDisplayName("U_RN1", client as never)).toBe(
      "Dan McAulay",
    );
  });

  it("falls back to name when display_name and real_name are empty", async () => {
    const client = makeClient({ display_name: "", real_name: "" });
    expect(await resolveDisplayName("U_FB1", client as never)).toBe("fallback");
  });

  it("falls back to userId when Slack call throws", async () => {
    const badClient = {
      users: {
        info: mock(async () => {
          throw new Error("missing_scope");
        }),
      },
    };
    expect(await resolveDisplayName("U_ERR", badClient as never)).toBe("U_ERR");
  });

  it("caches the result — client is called only once for repeated lookups", async () => {
    const client = makeClient({ display_name: "Cached" });
    await resolveDisplayName("U_CACHE", client as never);
    await resolveDisplayName("U_CACHE", client as never);
    expect(client.users.info).toHaveBeenCalledTimes(1);
  });

  it("clearCache() allows re-fetching after reset", async () => {
    const client = makeClient({ display_name: "Fresh" });
    await resolveDisplayName("U_CLR", client as never);
    clearCache();
    await resolveDisplayName("U_CLR", client as never);
    expect(client.users.info).toHaveBeenCalledTimes(2);
  });
});

describe("resolveUserEmail", () => {
  afterEach(() => {
    clearCache();
  });

  it("returns profile.email when present", async () => {
    const client = makeClient({
      display_name: "Dan",
      email: "dan@example.com",
    });
    expect(await resolveUserEmail("U_EMAIL1", client as never)).toBe(
      "dan@example.com",
    );
  });

  it("returns undefined when profile.email is absent (missing scope)", async () => {
    const client = makeClient({ display_name: "Dan" });
    expect(
      await resolveUserEmail("U_NOEMAIL", client as never),
    ).toBeUndefined();
  });

  it("returns undefined when Slack call throws", async () => {
    const badClient = {
      users: {
        info: mock(async () => {
          throw new Error("missing_scope");
        }),
      },
    };
    expect(
      await resolveUserEmail("U_ERR2", badClient as never),
    ).toBeUndefined();
  });

  it("shares the cache with resolveDisplayName — only one API call for both name and email", async () => {
    const client = makeClient({
      display_name: "Dan",
      email: "dan@example.com",
    });
    const name = await resolveDisplayName("U_SHARED", client as never);
    const email = await resolveUserEmail("U_SHARED", client as never);
    expect(name).toBe("Dan");
    expect(email).toBe("dan@example.com");
    expect(client.users.info).toHaveBeenCalledTimes(1);
  });
});
