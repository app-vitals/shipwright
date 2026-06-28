/**
 * plugins/shipwright/scripts/render-plan-upload.integration.test.ts
 *
 * Integration tests for the upload + shareable-URL flow of render-plan.ts.
 *
 * The HTTP client is INJECTED (a recorded fake `fetch` passed in as a
 * dependency) — NO global.fetch override, NO monkeypatching. We assert the
 * POST request shape (URL, Authorization header, raw-HTML body) and that the
 * absolute `url` from the 201 response is parsed and returned. The fallback
 * path (client throws / non-2xx) is asserted to write a local temp file and
 * never throw.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { FixedClock } from "./test-helpers/doubles.ts";
import { type UploadDeps, uploadDoc } from "./render-plan.ts";

const TOKEN = "test-token-abc";
const BASE = "https://docs.example.com";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** A fake fetch that records the request and returns a canned response. */
function recordingFetch(
  response: { status: number; json: unknown },
  log: RecordedRequest[],
): UploadDeps["fetch"] {
  return async (url, init) => {
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(rawHeaders)) {
      headers[k] = v;
    }
    log.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : String(init?.body),
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.json,
    };
  };
}

describe("uploadDoc — success path with injected fake fetch", () => {
  test("POSTs raw HTML to <base>/docs with bearer auth and returns the absolute url", async () => {
    const html = "<!DOCTYPE html><html><body>hi</body></html>";
    const log: RecordedRequest[] = [];
    const deps: UploadDeps = {
      fetch: recordingFetch(
        { status: 201, json: { id: "doc-123", url: `${BASE}/docs/doc-123` } },
        log,
      ),
      url: BASE,
      token: TOKEN,
      clock: FixedClock("2026-06-28T12:00:00Z"),
    };

    const result = await uploadDoc(html, deps);

    expect(result).toBe(`${BASE}/docs/doc-123`);
    expect(log.length).toBe(1);

    const req = log[0];
    expect(req.url).toBe(`${BASE}/docs`);
    expect(req.method).toBe("POST");
    expect(req.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // Body is the RAW html, not JSON-wrapped.
    expect(req.body).toBe(html);
  });

  test("trailing slash on the base url is tolerated", async () => {
    const html = "<html></html>";
    const log: RecordedRequest[] = [];
    const deps: UploadDeps = {
      fetch: recordingFetch(
        { status: 201, json: { id: "x", url: `${BASE}/docs/x` } },
        log,
      ),
      url: `${BASE}/`,
      token: TOKEN,
      clock: FixedClock("2026-06-28T12:00:00Z"),
    };

    const result = await uploadDoc(html, deps);

    expect(result).toBe(`${BASE}/docs/x`);
    expect(log[0].url).toBe(`${BASE}/docs`);
  });
});

describe("uploadDoc — fallback path writes a temp file, never throws", () => {
  function readResultPath(result: string | null): string {
    expect(result).not.toBeNull();
    const path = result as string;
    expect(existsSync(path)).toBe(true);
    return path;
  }

  test("non-2xx response → temp file written, contents are the html", async () => {
    const html = "<html><body>fallback</body></html>";
    const log: RecordedRequest[] = [];
    const deps: UploadDeps = {
      fetch: recordingFetch({ status: 500, json: { error: "boom" } }, log),
      url: BASE,
      token: TOKEN,
      clock: FixedClock("2026-06-28T12:00:00Z"),
    };

    const result = await uploadDoc(html, deps);
    const path = readResultPath(result);
    expect(readFileSync(path, "utf-8")).toBe(html);
    rmSync(path, { force: true });
  });

  test("client throws → temp file written, no throw out of uploadDoc", async () => {
    const html = "<html><body>thrown</body></html>";
    const deps: UploadDeps = {
      fetch: async () => {
        throw new Error("network down");
      },
      url: BASE,
      token: TOKEN,
      clock: FixedClock("2026-06-28T12:00:00Z"),
    };

    const result = await uploadDoc(html, deps);
    const path = readResultPath(result);
    expect(readFileSync(path, "utf-8")).toBe(html);
    rmSync(path, { force: true });
  });

  test("missing url field in 201 body → fallback temp file", async () => {
    const html = "<html>no-url</html>";
    const log: RecordedRequest[] = [];
    const deps: UploadDeps = {
      fetch: recordingFetch({ status: 201, json: { id: "only-id" } }, log),
      url: BASE,
      token: TOKEN,
      clock: FixedClock("2026-06-28T12:00:00Z"),
    };

    const result = await uploadDoc(html, deps);
    const path = readResultPath(result);
    expect(readFileSync(path, "utf-8")).toBe(html);
    rmSync(path, { force: true });
  });

  test("env vars unset (no url/token) → skips upload, writes temp file", async () => {
    const html = "<html>no-env</html>";
    const log: RecordedRequest[] = [];
    const deps: UploadDeps = {
      fetch: recordingFetch(
        { status: 201, json: { id: "x", url: `${BASE}/docs/x` } },
        log,
      ),
      url: undefined,
      token: undefined,
      clock: FixedClock("2026-06-28T12:00:00Z"),
    };

    const result = await uploadDoc(html, deps);
    const path = readResultPath(result);
    // No HTTP request should have been made.
    expect(log.length).toBe(0);
    expect(readFileSync(path, "utf-8")).toBe(html);
    rmSync(path, { force: true });
  });
});
