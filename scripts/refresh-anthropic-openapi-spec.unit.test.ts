/**
 * scripts/refresh-anthropic-openapi-spec.unit.test.ts
 * Unit tests for the pure/injected parts of the spec refresh script.
 */

import { describe, expect, it } from "bun:test";
import { gzipSync } from "node:zlib";
import {
  readPinnedSdkVersion,
  refreshAnthropicOpenApiSpec,
  specUrlForVersion,
} from "./refresh-anthropic-openapi-spec.ts";

describe("specUrlForVersion", () => {
  it("points at scripts/mock-spec.json.gz at the sdk-v<version> tag", () => {
    expect(specUrlForVersion("0.135.0")).toBe(
      "https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/sdk-v0.135.0/scripts/mock-spec.json.gz",
    );
  });
});

describe("readPinnedSdkVersion", () => {
  it("returns an exact version", () => {
    expect(
      readPinnedSdkVersion(
        JSON.stringify({ dependencies: { "@anthropic-ai/sdk": "1.2.3" } }),
      ),
    ).toBe("1.2.3");
  });

  it("rejects ranges so the spec cannot drift from the SDK", () => {
    expect(() =>
      readPinnedSdkVersion(
        JSON.stringify({ dependencies: { "@anthropic-ai/sdk": "^1.2.3" } }),
      ),
    ).toThrow(/exact/);
  });

  it("rejects a missing dependency", () => {
    expect(() =>
      readPinnedSdkVersion(JSON.stringify({ dependencies: {} })),
    ).toThrow(/@anthropic-ai\/sdk/);
  });
});

describe("refreshAnthropicOpenApiSpec", () => {
  const spec = gzipSync(JSON.stringify({ openapi: "3.1.0", paths: {} }));

  it("downloads the pinned spec, verifies it, and writes spec + version marker", async () => {
    const writes = new Map<string, Uint8Array | string>();
    const urls: string[] = [];
    const result = await refreshAnthropicOpenApiSpec({
      version: "0.135.0",
      outDir: "/out",
      fetchFn: (async (url: string) => {
        urls.push(url);
        return new Response(spec, { status: 200 });
      }) as unknown as typeof fetch,
      writeFile: (path, data) => {
        writes.set(path, data);
      },
    });
    expect(urls).toEqual([specUrlForVersion("0.135.0")]);
    expect(writes.get("/out/mock-spec.json.gz")).toEqual(new Uint8Array(spec));
    expect(writes.get("/out/SDK_VERSION")).toBe("0.135.0\n");
    expect(result.version).toBe("0.135.0");
  });

  it("fails without writing when the tag has no spec", async () => {
    const writes = new Map<string, unknown>();
    await expect(
      refreshAnthropicOpenApiSpec({
        version: "9.9.9",
        outDir: "/out",
        fetchFn: (async () =>
          new Response("404: Not Found", { status: 404 })) as typeof fetch,
        writeFile: (p, d) => {
          writes.set(p, d);
        },
      }),
    ).rejects.toThrow(/404/);
    expect(writes.size).toBe(0);
  });

  it("fails without writing when the download is not an OpenAPI 3.1 document", async () => {
    const writes = new Map<string, unknown>();
    await expect(
      refreshAnthropicOpenApiSpec({
        version: "0.135.0",
        outDir: "/out",
        fetchFn: (async () =>
          new Response(gzipSync(JSON.stringify({ swagger: "2.0" })), {
            status: 200,
          })) as typeof fetch,
        writeFile: (p, d) => {
          writes.set(p, d);
        },
      }),
    ).rejects.toThrow(/OpenAPI 3\.1/);
    expect(writes.size).toBe(0);
  });
});
