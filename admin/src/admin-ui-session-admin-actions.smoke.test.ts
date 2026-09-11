/**
 * admin/src/admin-ui-session-admin-actions.smoke.test.ts
 * Smoke tests for POST /admin/sessions/:slug/{archive,unarchive,rename}
 * (SESH-5.2).
 *
 * Uses app.request() against a minimal Hono<AdminUIEnv> instance with
 * registerSessionAdminActionsRoutes() applied directly — no real server, no
 * real task-store — mirroring admin-ui-session-follow.smoke.test.ts's
 * isolation shape. patchTaskStoreSession is injected as a plain in-memory
 * object double (per the "no mock.module()" isolation rule).
 */

import { describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import {
  type SessionAdminActionsDeps,
  registerSessionAdminActionsRoutes,
} from "./admin-ui-session-admin-actions.ts";
import type { AdminUIEnv } from "./admin-ui.ts";

// ─── Test doubles ─────────────────────────────────────────────────────────────

const DEFAULT_EMAIL = "dave@example.com";

function makeFakeRequireAuth(): MiddlewareHandler<AdminUIEnv> {
  return async (c, next) => {
    c.set("userEmail", c.req.header("x-test-user-email") ?? DEFAULT_EMAIL);
    c.set("isAdmin", c.req.header("x-test-is-admin") !== "false");
    await next();
  };
}

interface PatchCall {
  slug: string;
  patch: { title?: string | null; archived?: boolean };
}

function makeFakePatchTaskStoreSession(opts: { shouldThrow?: boolean } = {}): {
  fn: (
    slug: string,
    patch: { title?: string | null; archived?: boolean },
  ) => Promise<unknown>;
  calls: PatchCall[];
} {
  const calls: PatchCall[] = [];
  return {
    calls,
    fn: async (slug, patch) => {
      calls.push({ slug, patch });
      if (opts.shouldThrow) throw new Error("task-store unreachable");
      return { slug, ...patch };
    },
  };
}

function buildApp(
  overrides: {
    patchTaskStoreSession?: SessionAdminActionsDeps["patchTaskStoreSession"];
  } = {},
): { app: Hono<AdminUIEnv> } {
  const deps: SessionAdminActionsDeps = {
    requireAuth: makeFakeRequireAuth(),
    patchTaskStoreSession: overrides.patchTaskStoreSession,
  };
  const app = new Hono<AdminUIEnv>();
  registerSessionAdminActionsRoutes(app, deps);
  return { app };
}

async function postForm(
  app: Hono<AdminUIEnv>,
  path: string,
  opts: {
    isAdmin?: boolean;
    email?: string;
    form?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.isAdmin === false) headers["x-test-is-admin"] = "false";
  if (opts.email) headers["x-test-user-email"] = opts.email;

  if (opts.form) {
    const body = new URLSearchParams(opts.form);
    headers["content-type"] = "application/x-www-form-urlencoded";
    return await app.request(path, { method: "POST", headers, body });
  }
  return await app.request(path, { method: "POST", headers });
}

// ─── POST /admin/sessions/:slug/archive ────────────────────────────────────

describe("POST /admin/sessions/:slug/archive", () => {
  it("admin-archive-success: an admin archives, patchTaskStoreSession is called with { archived: true }, redirects with success flash", async () => {
    const { fn, calls } = makeFakePatchTaskStoreSession();
    const { app } = buildApp({ patchTaskStoreSession: fn });

    const res = await postForm(app, "/admin/sessions/some-slug/archive", {
      isAdmin: true,
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/admin/sessions/some-slug?success=archived",
    );
    expect(calls).toEqual([{ slug: "some-slug", patch: { archived: true } }]);
  });

  it("non-admin-hidden-403: a non-admin POST gets 403 and patchTaskStoreSession is never called", async () => {
    const { fn, calls } = makeFakePatchTaskStoreSession();
    const { app } = buildApp({ patchTaskStoreSession: fn });

    const res = await postForm(app, "/admin/sessions/some-slug/archive", {
      isAdmin: false,
    });

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("archive-missing-dep: no patchTaskStoreSession configured — redirects with error, does not throw", async () => {
    const { app } = buildApp({});

    const res = await postForm(app, "/admin/sessions/some-slug/archive", {
      isAdmin: true,
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/admin/sessions/some-slug?error=archive_failed",
    );
  });

  it("archive-throws: patchTaskStoreSession throwing redirects with error, does not crash, and is logged", async () => {
    const consoleErrorSpy = spyOn(console, "error").mockImplementation(
      () => {},
    );
    try {
      const { fn } = makeFakePatchTaskStoreSession({ shouldThrow: true });
      const { app } = buildApp({ patchTaskStoreSession: fn });

      const res = await postForm(app, "/admin/sessions/boom-slug/archive", {
        isAdmin: true,
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "/admin/sessions/boom-slug?error=archive_failed",
      );
      expect(consoleErrorSpy).toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

// ─── POST /admin/sessions/:slug/unarchive ──────────────────────────────────

describe("POST /admin/sessions/:slug/unarchive", () => {
  it("admin-unarchive-success: an admin unarchives, patchTaskStoreSession is called with { archived: false }, redirects with success flash", async () => {
    const { fn, calls } = makeFakePatchTaskStoreSession();
    const { app } = buildApp({ patchTaskStoreSession: fn });

    const res = await postForm(app, "/admin/sessions/some-slug/unarchive", {
      isAdmin: true,
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/admin/sessions/some-slug?success=unarchived",
    );
    expect(calls).toEqual([{ slug: "some-slug", patch: { archived: false } }]);
  });

  it("non-admin-hidden-403: a non-admin POST gets 403 and patchTaskStoreSession is never called", async () => {
    const { fn, calls } = makeFakePatchTaskStoreSession();
    const { app } = buildApp({ patchTaskStoreSession: fn });

    const res = await postForm(app, "/admin/sessions/some-slug/unarchive", {
      isAdmin: false,
    });

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("unarchive-missing-dep: no patchTaskStoreSession configured — redirects with error, does not throw", async () => {
    const { app } = buildApp({});

    const res = await postForm(app, "/admin/sessions/some-slug/unarchive", {
      isAdmin: true,
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/admin/sessions/some-slug?error=unarchive_failed",
    );
  });
});

// ─── POST /admin/sessions/:slug/rename ──────────────────────────────────────

describe("POST /admin/sessions/:slug/rename", () => {
  it("admin-rename-success: an admin renames, patchTaskStoreSession is called with the trimmed title, redirects with success flash", async () => {
    const { fn, calls } = makeFakePatchTaskStoreSession();
    const { app } = buildApp({ patchTaskStoreSession: fn });

    const res = await postForm(app, "/admin/sessions/some-slug/rename", {
      isAdmin: true,
      form: { newTitle: "  A Better Title  " },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/admin/sessions/some-slug?success=renamed",
    );
    expect(calls).toEqual([
      { slug: "some-slug", patch: { title: "A Better Title" } },
    ]);
  });

  it("non-admin-hidden-403: a non-admin POST gets 403 and patchTaskStoreSession is never called", async () => {
    const { fn, calls } = makeFakePatchTaskStoreSession();
    const { app } = buildApp({ patchTaskStoreSession: fn });

    const res = await postForm(app, "/admin/sessions/some-slug/rename", {
      isAdmin: false,
      form: { newTitle: "Nope" },
    });

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("rename-missing-dep: no patchTaskStoreSession configured — redirects with error, does not throw", async () => {
    const { app } = buildApp({});

    const res = await postForm(app, "/admin/sessions/some-slug/rename", {
      isAdmin: true,
      form: { newTitle: "Doesn't matter" },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/admin/sessions/some-slug?error=rename_failed",
    );
  });

  it("rename-blank-clears-title: submitting a blank newTitle calls patchTaskStoreSession with title: null", async () => {
    const { fn, calls } = makeFakePatchTaskStoreSession();
    const { app } = buildApp({ patchTaskStoreSession: fn });

    const res = await postForm(app, "/admin/sessions/some-slug/rename", {
      isAdmin: true,
      form: { newTitle: "   " },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/admin/sessions/some-slug?success=renamed",
    );
    expect(calls).toEqual([{ slug: "some-slug", patch: { title: null } }]);
  });

  it("rename-missing-field-clears-title: submitting no newTitle field at all calls patchTaskStoreSession with title: null", async () => {
    const { fn, calls } = makeFakePatchTaskStoreSession();
    const { app } = buildApp({ patchTaskStoreSession: fn });

    const res = await postForm(app, "/admin/sessions/some-slug/rename", {
      isAdmin: true,
      form: {},
    });

    expect(res.status).toBe(302);
    expect(calls).toEqual([{ slug: "some-slug", patch: { title: null } }]);
  });

  it("rename-throws: patchTaskStoreSession throwing redirects with error, does not crash", async () => {
    const consoleErrorSpy = spyOn(console, "error").mockImplementation(
      () => {},
    );
    try {
      const { fn } = makeFakePatchTaskStoreSession({ shouldThrow: true });
      const { app } = buildApp({ patchTaskStoreSession: fn });

      const res = await postForm(app, "/admin/sessions/boom-slug/rename", {
        isAdmin: true,
        form: { newTitle: "New Title" },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "/admin/sessions/boom-slug?error=rename_failed",
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
