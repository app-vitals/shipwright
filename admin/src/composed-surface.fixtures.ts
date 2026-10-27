/**
 * admin/src/composed-surface.fixtures.ts
 *
 * Builds what composed-surface.smoke.test.ts checks: the composed OpenAPI
 * document (platform plus the coding extension, as generate-admin-spec.ts
 * builds it) and the coding admin pages rendered by startAdmin()'s composed
 * app.
 */

import {
  applyOpenApiContributions,
  collectOpenApiContributions,
} from "@app-vitals/agent-admin/admin-extension";
import { buildPlatformAdminSpec } from "@app-vitals/agent-admin/admin-spec";
import {
  AGENT_ID,
  makeSessionCookie,
} from "@app-vitals/agent-admin/admin-ui.fixtures";
import {
  defaultTypeDirLister,
  SpecialtyRegistry,
} from "@app-vitals/agent-admin/specialty-manifest-loader";
import {
  createCodingTestApp,
  makeCodingMockDeps,
} from "./coding/admin-ui-coding.fixtures.ts";
import { adminExtensions, SHIPWRIGHT_SPECIALTIES_DIR } from "./main.ts";

/** The coding extension's static OpenAPI contribution. */
export function codingContribution() {
  return collectOpenApiContributions(adminExtensions);
}

/** The composed admin OpenAPI document (what admin/openapi.json holds). */
export function composedOpenApi() {
  return applyOpenApiContributions(
    buildPlatformAdminSpec(),
    codingContribution(),
  );
}

/**
 * The coding admin pages the composed app serves: a label, the request path,
 * and a marker the page carries only because the coding extension rendered it.
 */
export const SURFACE_PAGES: ReadonlyArray<{
  label: string;
  path: string;
  marker: string;
}> = [
  { label: "tasks", path: "/admin/tasks", marker: "<title>Tasks — Shipwright" },
  { label: "prs", path: "/admin/prs", marker: "<title>PRs — Shipwright" },
  {
    label: "queue activity",
    path: "/admin/queue-activity",
    marker: "Queue &amp; Activity — All Agents",
  },
  {
    label: "agent queue activity",
    path: `/admin/agents/${AGENT_ID}/queue-activity`,
    marker: "Queue &amp; Activity — Test Agent",
  },
];

/** Renders SURFACE_PAGES as an admin: label → status and body. */
export async function renderSurfacePages(): Promise<
  Record<string, { status: number; body: string }>
> {
  const cookie = `admin_session=${await makeSessionCookie()}`;
  const specialtyRegistry = new SpecialtyRegistry({
    typesDir: SHIPWRIGHT_SPECIALTIES_DIR,
    list: () => defaultTypeDirLister(SHIPWRIGHT_SPECIALTIES_DIR).sort(),
  });
  const app = createCodingTestApp(makeCodingMockDeps({ specialtyRegistry }));
  const pages: Record<string, { status: number; body: string }> = {};
  for (const page of SURFACE_PAGES) {
    const res = await app.request(page.path, { headers: { Cookie: cookie } });
    pages[page.label] = { status: res.status, body: await res.text() };
  }
  return pages;
}
