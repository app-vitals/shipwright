/**
 * admin/src/composed-surface.smoke.test.ts
 *
 * Contract test for what Shipwright owns: the coding extension composes into
 * the platform admin from @app-vitals/agent-admin intact. Every path,
 * operation and schema the coding extension contributes appears in the
 * composed OpenAPI document unchanged, none collides with a platform path, and
 * the coding admin pages render with their coding markers.
 *
 * Nothing here pins platform-owned output: drift in the platform surface is
 * the platform repo's responsibility, not a Shipwright test failure.
 */

import { describe, expect, it } from "bun:test";
import { buildPlatformAdminSpec } from "@app-vitals/agent-admin/admin-spec";
import { makeSessionCookie } from "@app-vitals/agent-admin/admin-ui.fixtures";
import { parseAdminApiKeys } from "@app-vitals/agent-admin/api-auth";
import { createGithubEnterpriseApp } from "@app-vitals/agent-admin/github-enterprise-api";
import {
  createCodingTestApp,
  makeCodingMockDeps,
} from "./coding/admin-ui-coding.fixtures.ts";
import {
  codingContribution,
  composedOpenApi,
  renderSurfacePages,
  SURFACE_PAGES,
} from "./composed-surface.fixtures.ts";

type Contribution = ReturnType<typeof codingContribution>;

/** "METHOD /path" for every operation in a paths object. */
function operationKeys(paths: Contribution["paths"]): string[] {
  return Object.entries(paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
  );
}

/**
 * Contributed operations that already exist in `platform`, and schemas that
 * exist there with a different definition (re-declaring an identical shared
 * schema such as `Error` is harmless).
 */
function findCollisions(
  platform: ReturnType<typeof buildPlatformAdminSpec>,
  contribution: Contribution,
): string[] {
  const platformOps = new Set(operationKeys(platform.paths));
  const platformSchemas = platform.components?.schemas ?? {};
  return [
    ...operationKeys(contribution.paths).filter((op) => platformOps.has(op)),
    ...Object.keys(contribution.schemas)
      .filter(
        (name) =>
          name in platformSchemas &&
          JSON.stringify(platformSchemas[name]) !==
            JSON.stringify(contribution.schemas[name]),
      )
      .map((name) => `schema ${name}`),
  ];
}

describe("coding extension composes into the platform admin (AGR-4.2)", async () => {
  const contribution = codingContribution();
  const doc = composedOpenApi();
  const platform = buildPlatformAdminSpec();

  it("contributes at least one operation and schema", () => {
    expect(operationKeys(contribution.paths).length).toBeGreaterThan(0);
    expect(Object.keys(contribution.schemas).length).toBeGreaterThan(0);
  });

  it("every coding operation appears in the composed document equal to its contribution", () => {
    for (const [path, methods] of Object.entries(contribution.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        expect(
          (doc.paths[path] as Record<string, unknown> | undefined)?.[method],
        ).toEqual(op);
      }
    }
  });

  it("every coding schema appears in the composed document equal to its contribution", () => {
    for (const [name, schema] of Object.entries(contribution.schemas)) {
      expect(doc.components?.schemas?.[name]).toEqual(schema);
    }
  });

  it("no coding path or schema collides with a platform one", () => {
    expect(findCollisions(platform, contribution)).toEqual([]);
  });

  it("detects a coding operation that collides with a platform operation", () => {
    const [platformPath, methods] = Object.entries(platform.paths)[0] ?? [];
    const [platformMethod] = Object.keys(methods ?? {});
    if (!platformPath || !platformMethod)
      throw new Error("empty platform spec");
    const colliding: Contribution = {
      paths: { [platformPath]: { [platformMethod]: { responses: {} } } },
      schemas: {},
    };
    expect(findCollisions(platform, colliding)).toEqual([
      `${platformMethod.toUpperCase()} ${platformPath}`,
    ]);
  });

  it("detects a coding schema that collides with a platform schema", () => {
    const [name] = Object.keys(platform.components?.schemas ?? {});
    if (!name) throw new Error("no platform schemas");
    const colliding: Contribution = {
      paths: {},
      schemas: { [name]: { type: "string" } },
    };
    expect(findCollisions(platform, colliding)).toEqual([`schema ${name}`]);
  });

  it("coding admin pages return 200 and carry their coding markers", async () => {
    const pages = await renderSurfacePages();
    for (const { label, marker } of SURFACE_PAGES) {
      expect(pages[label]?.status).toBe(200);
      expect(pages[label]?.body).toContain(marker);
    }
  });
});

describe("enterprise GitHub apps surface composes unconfigured (GHE-1.7)", () => {
  const ADMIN_KEY = "tok-ghe-17";
  const api = createGithubEnterpriseApp({
    // No apps configured: the optional feature is off.
    appService: { list: async () => [], get: async () => null } as never,
    agentService: {} as never,
    agentEnvService: {} as never,
    sessionSecret: "test-secret-32chars-for-ghe-api!!",
    adminApiKeys: parseAdminApiKeys(`admin:${ADMIN_KEY}:*`),
    agentTokenService: { validate: async () => null },
  });
  const githubEnterpriseApi = (path: string, init?: RequestInit) =>
    api.request(path, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
    });

  it("mounts the settings page and shows the empty state alongside the coding pages", async () => {
    const app = createCodingTestApp({
      ...makeCodingMockDeps(),
      githubEnterpriseApi,
    });
    const cookie = `admin_session=${await makeSessionCookie()}`;
    const res = await app.request("/admin/settings/github-enterprise", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Installer app");
    expect(html).toContain("Not configured");
    const tasks = await app.request("/admin/tasks", {
      headers: { Cookie: cookie },
    });
    expect(tasks.status).toBe(200);
  });

  it("mounts the status route and it reports no apps configured", async () => {
    const res = await githubEnterpriseApi("/github-enterprise/apps");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body) ? body : (body.apps ?? [])).toEqual([]);
  });

  it("is invisible when the platform does not wire the API", async () => {
    const app = createCodingTestApp(makeCodingMockDeps());
    const cookie = `admin_session=${await makeSessionCookie()}`;
    const res = await app.request("/admin/settings/github-enterprise", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(404);
  });
});
