/**
 * metrics/src/dashboard/app.unit.test.js
 * Unit tests for the pure fetch-sequencing helper extracted from app.js
 * (fetchSequential). app.js is a plain browser `<script>` (not an ES module,
 * no DOM globals touched outside DOMContentLoaded) — importing it for its
 * side effect exposes the pure helper on `globalThis.__dashboardAppTestExports`
 * only when `window` is undefined (i.e. under bun:test), so this file needs
 * no DOM/browser globals to run.
 */

import { beforeAll, describe, expect, test } from "bun:test";

let fetchSequential;

beforeAll(async () => {
  await import("./app.js");
  ({ fetchSequential } = globalThis.__dashboardAppTestExports);
});

describe("fetchSequential", () => {
  test("issues requests strictly sequentially — the 2nd request isn't issued until the 1st settles", async () => {
    const callOrder = [];
    let resolveFirst;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    const fakeFetch = (url) => {
      callOrder.push(url);
      if (url === "/one") {
        return firstPromise.then(() => ({
          json: async () => ({ id: "one" }),
        }));
      }
      return Promise.resolve({ json: async () => ({ id: url }) });
    };

    const entries = [
      { url: "/one", parse: (r) => r.json() },
      { url: "/two", parse: (r) => r.json() },
      { url: "/three", parse: (r) => r.json() },
    ];

    const resultPromise = fetchSequential(entries, fakeFetch);

    // Only the first request should have been issued so far — the second
    // must not fire until the first request's promise settles.
    await Promise.resolve();
    await Promise.resolve();
    expect(callOrder).toEqual(["/one"]);

    resolveFirst();
    const results = await resultPromise;

    expect(callOrder).toEqual(["/one", "/two", "/three"]);
    expect(results).toEqual([{ id: "one" }, { id: "/two" }, { id: "/three" }]);
  });

  test("a per-entry onError fallback (e.g. to null) does not abort subsequent requests", async () => {
    const callOrder = [];
    const fakeFetch = (url) => {
      callOrder.push(url);
      if (url === "/fails") {
        return Promise.reject(new Error("boom"));
      }
      return Promise.resolve({ json: async () => ({ ok: url }) });
    };

    const errors = [];
    const entries = [
      { url: "/before", parse: (r) => r.json() },
      {
        url: "/fails",
        parse: (r) => r.json(),
        onError: (err) => {
          errors.push(err);
          return null;
        },
      },
      { url: "/after", parse: (r) => r.json() },
    ];

    const results = await fetchSequential(entries, fakeFetch);

    expect(callOrder).toEqual(["/before", "/fails", "/after"]);
    expect(results).toEqual([{ ok: "/before" }, null, { ok: "/after" }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0].message).toBe("boom");
  });

  test("an entry without onError propagates its rejection (matches summary/trends' uncaught behavior)", async () => {
    const fakeFetch = (url) => {
      if (url === "/summary") return Promise.reject(new Error("summary down"));
      return Promise.resolve({ json: async () => ({ ok: true }) });
    };

    const entries = [{ url: "/summary", parse: (r) => r.json() }];

    await expect(fetchSequential(entries, fakeFetch)).rejects.toThrow(
      "summary down",
    );
  });

  test("a rejection with no onError still stops later entries from being issued (propagates immediately)", async () => {
    const callOrder = [];
    const fakeFetch = (url) => {
      callOrder.push(url);
      if (url === "/summary") return Promise.reject(new Error("summary down"));
      return Promise.resolve({ json: async () => ({ ok: true }) });
    };

    const entries = [
      { url: "/summary", parse: (r) => r.json() },
      { url: "/trends", parse: (r) => r.json() },
    ];

    await expect(fetchSequential(entries, fakeFetch)).rejects.toThrow(
      "summary down",
    );
    expect(callOrder).toEqual(["/summary"]);
  });

  test("parse errors also route through onError when provided", async () => {
    const fakeFetch = () =>
      Promise.resolve({
        json: async () => {
          throw new Error("bad json");
        },
      });

    const errors = [];
    const entries = [
      {
        url: "/queue",
        parse: (r) => r.json(),
        onError: (err) => {
          errors.push(err);
          return null;
        },
      },
    ];

    const results = await fetchSequential(entries, fakeFetch);
    expect(results).toEqual([null]);
    expect(errors).toHaveLength(1);
  });

  test("empty entries resolves to an empty array without calling fetch", async () => {
    let called = false;
    const fakeFetch = () => {
      called = true;
      return Promise.resolve({ json: async () => ({}) });
    };

    const results = await fetchSequential([], fakeFetch);
    expect(results).toEqual([]);
    expect(called).toBe(false);
  });
});
