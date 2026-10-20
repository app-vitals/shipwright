import { describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import {
  ADMIN_EXTENSION_HOOK_ORDER,
  type AdminBackgroundPass,
  type AdminExtension,
  type AdminExtensionContext,
  applyOpenApiContributions,
  collectOpenApiContributions,
  mountRouteContributions,
  renderAgentDetailCards,
  resolveAdminExtensions,
  startBackgroundPasses,
} from "./admin-extension.ts";

// The seam only hands the context through to hooks, so an opaque stand-in is
// enough — no hook under test reads from it.
const ctx = { env: {} } as unknown as AdminExtensionContext;

describe("resolveAdminExtensions", () => {
  it("no extensions resolves to empty contributions", () => {
    expect(resolveAdminExtensions([], ctx)).toEqual({
      apiDeps: {},
      uiDeps: {},
      apiRoutes: [],
      adminUiRoutes: [],
      agentDetailCards: [],
      backgroundPasses: [],
    });
  });

  it("an extension with no hooks changes nothing", () => {
    expect(resolveAdminExtensions([{}], ctx)).toEqual(
      resolveAdminExtensions([], ctx),
    );
    expect(resolveAdminExtensions([{ name: "empty" }, {}], ctx)).toEqual(
      resolveAdminExtensions([], ctx),
    );
  });

  it("invokes each hook across all extensions, hook by hook in the documented order", () => {
    const calls: string[] = [];
    const tracking = (id: string): AdminExtension => ({
      services: (c) => {
        calls.push(`${id}:services:${c === ctx}`);
        return {};
      },
      apiRoutes: (c) => {
        calls.push(`${id}:apiRoutes:${c === ctx}`);
        return [];
      },
      adminUiRoutes: (c) => {
        calls.push(`${id}:adminUiRoutes:${c === ctx}`);
        return [];
      },
      agentDetailCards: (c) => {
        calls.push(`${id}:agentDetailCards:${c === ctx}`);
        return [];
      },
      backgroundPasses: (c) => {
        calls.push(`${id}:backgroundPasses:${c === ctx}`);
        return [];
      },
      openApi: () => {
        calls.push(`${id}:openApi`);
        return {};
      },
    });
    resolveAdminExtensions([tracking("a"), tracking("b")], ctx);
    expect(calls).toEqual(
      ADMIN_EXTENSION_HOOK_ORDER.flatMap((hook) => [
        `a:${hook}:true`,
        `b:${hook}:true`,
      ]),
    );
    // openApi is a static, context-free hook resolved separately (spec
    // generation has no live context), never during resolve.
    expect(calls.some((c) => c.endsWith(":openApi"))).toBe(false);
  });

  it("pins the hook order: services first, background passes last", () => {
    expect([...ADMIN_EXTENSION_HOOK_ORDER]).toEqual([
      "services",
      "apiRoutes",
      "adminUiRoutes",
      "agentDetailCards",
      "backgroundPasses",
    ]);
  });

  it("concatenates list contributions in extension order", () => {
    const app = new Hono();
    const pass = (name: string): AdminBackgroundPass => ({
      name,
      logPrefix: `[${name}]`,
      intervalMs: 1000,
      tick: async () => {},
    });
    const card = (name: string) => ({ name, render: async () => name });
    const resolved = resolveAdminExtensions(
      [
        {
          apiRoutes: () => [{ path: "/a", app }],
          adminUiRoutes: () => [{ path: "/ui-a", app }],
          agentDetailCards: () => [card("card-a")],
          backgroundPasses: () => [pass("a")],
        },
        {},
        {
          apiRoutes: () => [{ path: "/b", app }],
          agentDetailCards: () => [card("card-b")],
          backgroundPasses: () => [pass("b")],
        },
      ],
      ctx,
    );
    expect(resolved.apiRoutes.map((r) => r.path)).toEqual(["/a", "/b"]);
    expect(resolved.adminUiRoutes.map((r) => r.path)).toEqual(["/ui-a"]);
    expect(resolved.agentDetailCards.map((c) => c.name)).toEqual([
      "card-a",
      "card-b",
    ]);
    expect(resolved.backgroundPasses.map((p) => p.name)).toEqual(["a", "b"]);
  });

  it("merges service deps in extension order, later extensions winning", () => {
    const first = { getMany: async () => new Map() } as never;
    const second = { getMany: async () => new Map() } as never;
    const resolved = resolveAdminExtensions(
      [
        { services: () => ({ api: { devTaskAdherenceService: first } }) },
        {
          services: () => ({
            api: { devTaskAdherenceService: second },
            ui: { timezone: "UTC" },
          }),
        },
      ],
      ctx,
    );
    expect(resolved.apiDeps.devTaskAdherenceService).toBe(second);
    expect(resolved.uiDeps).toEqual({ timezone: "UTC" });
  });
});

describe("collectOpenApiContributions / applyOpenApiContributions", () => {
  const doc = {
    openapi: "3.1.0",
    paths: { "/agents": { get: { summary: "list" } } } as Record<
      string,
      Record<string, unknown>
    >,
    components: { schemas: { Agent: { type: "object" } } } as {
      schemas?: Record<string, unknown>;
    },
  };

  it("no extensions or hookless extensions contribute nothing", () => {
    expect(collectOpenApiContributions([])).toEqual({ paths: {}, schemas: {} });
    expect(collectOpenApiContributions([{}, { name: "x" }])).toEqual({
      paths: {},
      schemas: {},
    });
  });

  it("an empty contribution returns the document unchanged (same reference, same JSON)", () => {
    const before = JSON.stringify(doc, null, 2);
    const out = applyOpenApiContributions(doc, collectOpenApiContributions([]));
    expect(out).toBe(doc);
    expect(JSON.stringify(out, null, 2)).toBe(before);
  });

  it("merges contributed paths at the method level and appends schemas", () => {
    const contribution = collectOpenApiContributions([
      {
        openApi: () => ({
          paths: {
            "/agents": { post: { summary: "create" } },
            "/coding/x": { get: { summary: "x" } },
          },
          schemas: { CodingX: { type: "string" } },
        }),
      },
    ]);
    const out = applyOpenApiContributions(doc, contribution);
    expect(out.paths["/agents"]).toEqual({
      get: { summary: "list" },
      post: { summary: "create" },
    });
    expect(out.paths["/coding/x"]).toEqual({ get: { summary: "x" } });
    expect(out.components.schemas).toEqual({
      Agent: { type: "object" },
      CodingX: { type: "string" },
    });
    // The input document is not mutated.
    expect(doc.paths["/agents"]).toEqual({ get: { summary: "list" } });
  });
});

describe("mountRouteContributions", () => {
  it("mounts each contribution at its path, in order", async () => {
    const root = new Hono();
    const a = new Hono().get("/ping", (c) => c.text("a"));
    const b = new Hono().get("/ping", (c) => c.text("b"));
    mountRouteContributions(root, [
      { path: "/x", app: a },
      { path: "/y", app: b },
    ]);
    expect(await (await root.request("/x/ping")).text()).toBe("a");
    expect(await (await root.request("/y/ping")).text()).toBe("b");
  });

  it("no contributions leaves the root's routes untouched", () => {
    const root = new Hono().get("/health", (c) => c.text("ok"));
    const before = root.routes.length;
    mountRouteContributions(root, []);
    expect(root.routes.length).toBe(before);
  });
});

describe("startBackgroundPasses", () => {
  it("schedules each pass at its interval and logs its start", () => {
    const scheduled: number[] = [];
    const logs: string[] = [];
    startBackgroundPasses(
      [
        {
          name: "a",
          logPrefix: "[a]",
          intervalMs: 10,
          tick: async () => {},
        },
        {
          name: "b",
          logPrefix: "[b]",
          intervalMs: 20,
          tick: async () => {},
        },
      ],
      {
        schedule: (_fn, ms) => {
          scheduled.push(ms);
        },
        log: (m) => logs.push(m),
        error: () => {},
      },
    );
    expect(scheduled).toEqual([10, 20]);
    expect(logs).toEqual([
      "[admin] a started (interval: 10ms)",
      "[admin] b started (interval: 20ms)",
    ]);
  });

  it("a failing tick is logged with the pass's prefix and never throws", async () => {
    const fns: (() => void)[] = [];
    const errors: unknown[][] = [];
    startBackgroundPasses(
      [
        {
          name: "boom",
          logPrefix: "[boom]",
          intervalMs: 5,
          tick: async () => {
            throw new Error("nope");
          },
        },
      ],
      {
        schedule: (fn) => {
          fns.push(fn);
        },
        log: () => {},
        error: (...args) => errors.push(args),
      },
    );
    fns[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(errors[0][0]).toBe("[boom] tick error:");
    expect((errors[0][1] as Error).message).toBe("nope");
  });

  it("no passes schedules nothing", () => {
    let scheduled = 0;
    startBackgroundPasses([], {
      schedule: () => {
        scheduled++;
      },
      log: () => {},
      error: () => {},
    });
    expect(scheduled).toBe(0);
  });
});

describe("renderAgentDetailCards", () => {
  const cardCtx = { agentId: "agent-1", userEmail: "a@b.c", isAdmin: true };

  it("no slots renders nothing", async () => {
    expect(await renderAgentDetailCards([], cardCtx)).toEqual([]);
  });

  it("renders slots in order with the card context", async () => {
    const seen: unknown[] = [];
    const html = await renderAgentDetailCards(
      [
        {
          name: "one",
          render: async (c) => {
            seen.push(c);
            return "<div>1</div>";
          },
        },
        { name: "two", render: async () => "<div>2</div>" },
      ],
      cardCtx,
    );
    expect(html).toEqual(["<div>1</div>", "<div>2</div>"]);
    expect(seen).toEqual([cardCtx]);
  });

  it("a failing slot is omitted (and logged), the others still render", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const html = await renderAgentDetailCards(
        [
          {
            name: "bad",
            render: async () => {
              throw new Error("down");
            },
          },
          { name: "ok", render: async () => "<div>ok</div>" },
        ],
        cardCtx,
      );
      expect(html).toEqual(["<div>ok</div>"]);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0][0])).toContain("bad");
    } finally {
      errors.mockRestore();
    }
  });
});
