/**
 * admin/src/composed-surface.fixtures.ts
 *
 * Fingerprints Shipwright's composed admin surface: the composed OpenAPI
 * document (platform plus the coding extension, as generate-admin-spec.ts
 * builds it) and the rendered HTML of a fixed set of admin UI pages (platform
 * UI plus the coding UI, as startAdmin() composes them).
 *
 * composed-surface.smoke.test.ts compares these fingerprints against the
 * pre-swap baseline (fixtures/composed-surface.baseline.json, captured on the
 * in-repo admin before AGR-4.2 moved the platform onto @app-vitals/agent-admin)
 * plus a pinned expected diff, so any change to the composed surface other
 * than the pinned one fails.
 */

import { createHash } from "node:crypto";
import {
  applyOpenApiContributions,
  collectOpenApiContributions,
} from "@app-vitals/agent-admin/admin-extension";
import { buildPlatformAdminSpec } from "@app-vitals/agent-admin/admin-spec";
import {
  AGENT_ID,
  makeSessionCookie,
} from "@app-vitals/agent-admin/admin-ui.fixtures";
import { SpecialtyRegistry } from "@app-vitals/agent-admin/specialty-manifest-loader";
import {
  createCodingTestApp,
  makeCodingMockDeps,
} from "./coding/admin-ui-coding.fixtures.ts";
import { adminExtensions, SHIPWRIGHT_SPECIALTIES_DIR } from "./main.ts";

/** Fingerprints of the composed admin surface, each value a short sha256. */
export interface ComposedSurface {
  /** "METHOD /path" → hash of the operation object. */
  operations: Record<string, string>;
  /** components.schemas name → hash of the schema. */
  schemas: Record<string, string>;
  /** Hash of everything else in the document (openapi, info, ...). */
  document: string;
  /** Page label → "<status> <hash of body>". */
  pages: Record<string, string>;
}

/** JSON with object keys sorted, so the hash ignores key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** The composed admin OpenAPI document (what admin/openapi.json holds). */
export function composedOpenApi() {
  return applyOpenApiContributions(
    buildPlatformAdminSpec(),
    collectOpenApiContributions(adminExtensions),
  );
}

export function fingerprintOpenApi(
  doc: ReturnType<typeof composedOpenApi>,
): Pick<ComposedSurface, "operations" | "schemas" | "document"> {
  const operations: Record<string, string> = {};
  for (const [path, def] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(def)) {
      operations[`${method.toUpperCase()} ${path}`] = hash(canonical(op));
    }
  }
  const schemas: Record<string, string> = {};
  for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
    schemas[name] = hash(canonical(schema));
  }
  const { paths: _paths, components, ...rest } = doc;
  const { schemas: _schemas, ...otherComponents } = components ?? {};
  return {
    operations,
    schemas,
    document: hash(canonical({ ...rest, components: otherComponents })),
  };
}

/**
 * The pages rendered for the fingerprint. Each entry is a label, the request
 * path, and optional env vars the fixture agent carries (the agent detail page
 * renders differently for an agent with a GitHub App).
 */
export const SURFACE_PAGES: ReadonlyArray<{
  label: string;
  path: string;
  env?: Record<string, string>;
}> = [
  { label: "login", path: "/admin/login" },
  { label: "agents list", path: "/admin/agents" },
  { label: "new agent", path: "/admin/agents/new" },
  { label: "agent detail", path: `/admin/agents/${AGENT_ID}` },
  {
    label: "agent detail (GitHub App)",
    path: `/admin/agents/${AGENT_ID}`,
    env: { FOO: "bar", GH_APP_ID: "12345" },
  },
  {
    label: "agent queue activity",
    path: `/admin/agents/${AGENT_ID}/queue-activity`,
  },
  { label: "queue activity", path: "/admin/queue-activity" },
  { label: "chat", path: "/admin/chat" },
  { label: "provision", path: "/admin/provision" },
  { label: "tasks", path: "/admin/tasks" },
  { label: "prs", path: "/admin/prs" },
  { label: "offline", path: "/admin/offline.html" },
  { label: "manifest", path: "/admin/manifest.webmanifest" },
  { label: "service worker", path: "/admin/sw.js" },
];

/**
 * Renders SURFACE_PAGES as an admin and fingerprints each response body.
 * `onBody` receives each raw body, for inspecting a fingerprint change.
 */
export async function fingerprintPages(
  onBody?: (label: string, body: string) => void,
): Promise<ComposedSurface["pages"]> {
  const cookie = `admin_session=${await makeSessionCookie()}`;
  // The specialties startAdmin() reads once main.ts has applied Shipwright's
  // defaults (the "new agent" page lists them).
  const specialtyRegistry = new SpecialtyRegistry({
    typesDir: SHIPWRIGHT_SPECIALTIES_DIR,
  });
  const pages: Record<string, string> = {};
  for (const page of SURFACE_PAGES) {
    const deps = makeCodingMockDeps({
      specialtyRegistry,
      ...(page.env
        ? {
            agentEnvService: {
              ...makeCodingMockDeps().agentEnvService,
              getByAgentId: async () => ({
                env: page.env ?? {},
                secretKeys: [],
              }),
            },
          }
        : {}),
    });
    const res = await createCodingTestApp(deps).request(page.path, {
      headers: { Cookie: cookie },
    });
    const body = await res.text();
    onBody?.(page.label, body);
    pages[page.label] = `${res.status} ${hash(body)}`;
  }
  return pages;
}

export async function fingerprintComposedSurface(): Promise<ComposedSurface> {
  return {
    ...fingerprintOpenApi(composedOpenApi()),
    pages: await fingerprintPages(),
  };
}

/** The difference between two fingerprints, values taken from `after`. */
export interface SurfaceDiff {
  added: Record<string, string>;
  removed: string[];
  changed: Record<string, string>;
}

export function diffRecords(
  before: Record<string, string>,
  after: Record<string, string>,
): SurfaceDiff {
  const added: Record<string, string> = {};
  const changed: Record<string, string> = {};
  for (const [key, value] of Object.entries(after)) {
    if (!(key in before)) added[key] = value;
    else if (before[key] !== value) changed[key] = value;
  }
  const removed = Object.keys(before)
    .filter((key) => !(key in after))
    .sort();
  return { added, removed, changed };
}
