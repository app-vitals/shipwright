/**
 * admin/src/admin-extension.ts
 *
 * The extension seam between the generic admin platform (admin-boot.ts:
 * agents, envs, crons, tokens, plugins, accounts, provisioning, the admin UI
 * shell and its sweepers) and specialty-specific admin behavior (Shipwright:
 * the coding extension). Mirrors the agent's seam in
 * agent/src/runtime/agent-extension.ts.
 *
 * startAdmin(extensions) resolves every extension once, right after the
 * platform services exist and before any route is mounted, calling each hook
 * across all extensions in ADMIN_EXTENSION_HOOK_ORDER:
 *
 *   serviceIntegrations(env) — optional per-agent service integrations
 *                            (service-integration.ts). Unlike the hooks below
 *                            it takes only env and is resolved BEFORE the
 *                            provisioner is built, since the provisioner and
 *                            agent deletion consume it
 *   services(ctx)          — extra service deps spread into createAdminApp /
 *                            createAdminUIApp (later extensions win)
 *   apiRoutes(ctx)         — API sub-apps, mounted after the platform APIs and
 *                            before the admin UI (so the UI never shadows them)
 *   adminUiRoutes(ctx)     — admin UI sub-apps, mounted after the platform UI
 *   agentDetailCards(ctx)  — extra cards on the agent detail page, each placed
 *                            in the header or the Configuration group
 *   backgroundPasses(ctx)  — interval loops, started after the platform sweepers
 *
 * openApi() is static (no context): scripts/generate-admin-spec.ts calls it to
 * fold extension routes/schemas into admin/openapi.json without booting.
 *
 * Every hook is optional; no extension (or a hookless one) reproduces the bare
 * platform exactly. This file must not import any coding module — main.ts
 * (the composition root) is the only file that wires a concrete extension in.
 */

import type { PoolLike } from "@shipwright/lib/pool-observability";
import type { ErrorCapturingClient } from "@shipwright/lib/sentry";
import type { Hono } from "hono";
import type { PrismaClient } from "../prisma/client/client.ts";
import type { AccountService } from "./accounts.ts";
import type { AdminUIDeps } from "./admin-ui.ts";
import type { AgentCronJobService } from "./agent-cron-jobs.ts";
import type { AgentCronRunService } from "./agent-cron-runs.ts";
import type { AgentEnvService } from "./agent-envs.ts";
import type { AgentGitHubInstallationsService } from "./agent-github-installations.ts";
import type { AgentMemberService } from "./agent-members.ts";
import type { AgentProvisioner } from "./agent-provisioner.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import type { AgentService } from "./agents.ts";
import type { AdminDeps, parseAdminApiKeys } from "./agents-api.ts";
import type { AgentPhaseMethodologyServiceLike } from "./api.ts";
import type { createCallerScopeResolver } from "./caller-scope.ts";
import type { PushService } from "./push-service.ts";
import type { ServiceIntegration } from "./service-integration.ts";

/** The platform services an extension may build on. */
export interface AdminPlatformServices {
  agentService: AgentService;
  agentEnvService: AgentEnvService;
  agentCronJobService: AgentCronJobService;
  agentCronRunService: AgentCronRunService;
  agentGitHubInstallationsService: AgentGitHubInstallationsService;
  agentTokenService: AgentTokenService;
  agentMemberService: AgentMemberService;
  accountService: AccountService;
  callerScopeResolver: ReturnType<typeof createCallerScopeResolver>;
  provisioner: AgentProvisioner;
}

/** Everything an extension's hooks may need from the platform. */
export interface AdminExtensionContext {
  env: NodeJS.ProcessEnv;
  prisma: PrismaClient;
  sessionSecret: string;
  adminApiKeys: ReturnType<typeof parseAdminApiKeys>;
  /** SHIPWRIGHT_ADMIN_ALLOWED_EMAILS, parsed: operators who see everything. */
  adminAllowedEmails: string[];
  /** The admin UI's public base URL (SHIPWRIGHT_ADMIN_APP_BASE_URL). */
  appBaseUrl: string;
  /** SHIPWRIGHT_ADMIN_TZ, when set: the admin UI's display timezone. */
  timezone?: string;
  /** Web Push, present only when VAPID is fully configured. */
  push?: { service: PushService; maxDetail: string; vapidPublicKey: string };
  /** Sentry, present only when SENTRY_DSN is set (as the admin API gets it). */
  sentryClient?: ErrorCapturingClient;
  /** Admin's pg pool (PLO-1.3), for pool-timeout capture context. */
  pool?: PoolLike;
  services: AdminPlatformServices;
}

// Extension sub-apps carry their own Env/Schema generics; Hono's route() is
// generic over them, so the contribution type must accept any.
// biome-ignore lint/suspicious/noExplicitAny: see above
type AnyHono = Hono<any, any, any>;

/** A sub-app mounted on the root at `path` via root.route(path, app). */
export interface AdminRouteContribution {
  path: string;
  app: AnyHono;
}

/** Extra deps merged over the platform's createAdminApp / createAdminUIApp deps. */
export interface AdminExtensionServices {
  api?: Partial<AdminDeps>;
  ui?: Partial<AdminUIDeps>;
  /**
   * Supplies the runtime API's phase-methodology service (GET
   * /agents/:id/config's `phaseMethodology`). Absent from every extension →
   * the runtime app omits the field.
   */
  agentPhaseMethodologyService?: AgentPhaseMethodologyServiceLike;
}

export interface AgentDetailCardContext {
  agentId: string;
  userEmail: string;
  isAdmin: boolean;
  /** The agent's owning account; null for unassigned agents. */
  accountId?: string | null;
  /** The admin UI's display timezone (IANA name). */
  timezone?: string;
}

/**
 * Where a card lands on the agent detail page:
 *   header        — above the stat strip, after the page's alerts (default)
 *   configuration — inside the Configuration group, after Repos
 */
export type AgentDetailCardPlacement = "header" | "configuration";

/**
 * One extra card on GET /admin/agents/:id. render() returns trusted HTML — the
 * extension escapes its own content. A throwing render omits just that card.
 */
export interface AgentDetailCardSlot {
  name: string;
  /** Defaults to "header". */
  placement?: AgentDetailCardPlacement;
  render(ctx: AgentDetailCardContext): Promise<string>;
}

/** An interval loop registered in startAdmin, never inside an app factory. */
export interface AdminBackgroundPass {
  name: string;
  /** Prefix for the non-fatal failure log: `${logPrefix} tick error:`. */
  logPrefix: string;
  intervalMs: number;
  tick(): Promise<unknown>;
}

/** OpenAPI fragments folded into the admin document (paths use `{param}`). */
export interface AdminOpenApiContribution {
  paths?: Record<string, Record<string, unknown>>;
  schemas?: Record<string, unknown>;
  /**
   * Where new paths/schemas land in the document: contributed key → the key
   * it is inserted directly after (a platform key, or a contributed key placed
   * earlier). New keys without a placement are appended. Lets an extension's
   * routes keep a stable position in the generated document.
   */
  placeAfter?: {
    paths?: Record<string, string>;
    schemas?: Record<string, string>;
  };
}

export interface AdminExtension {
  name?: string;
  /** See the header: env-only, resolved before the provisioner is built. */
  serviceIntegrations?(env: NodeJS.ProcessEnv): ServiceIntegration[];
  services?(ctx: AdminExtensionContext): AdminExtensionServices;
  apiRoutes?(ctx: AdminExtensionContext): AdminRouteContribution[];
  adminUiRoutes?(ctx: AdminExtensionContext): AdminRouteContribution[];
  agentDetailCards?(ctx: AdminExtensionContext): AgentDetailCardSlot[];
  backgroundPasses?(ctx: AdminExtensionContext): AdminBackgroundPass[];
  openApi?(): AdminOpenApiContribution;
}

/** The order resolveAdminExtensions calls the context hooks in. */
export const ADMIN_EXTENSION_HOOK_ORDER = [
  "services",
  "apiRoutes",
  "adminUiRoutes",
  "agentDetailCards",
  "backgroundPasses",
] as const;

export interface ResolvedAdminExtensions {
  apiDeps: Partial<AdminDeps>;
  uiDeps: Partial<AdminUIDeps>;
  agentPhaseMethodologyService?: AgentPhaseMethodologyServiceLike;
  apiRoutes: AdminRouteContribution[];
  adminUiRoutes: AdminRouteContribution[];
  agentDetailCards: AgentDetailCardSlot[];
  backgroundPasses: AdminBackgroundPass[];
}

/**
 * Calls every context hook once, hook by hook (ADMIN_EXTENSION_HOOK_ORDER),
 * each across all extensions in order. Lists concatenate; service deps merge
 * with later extensions winning.
 */
export function resolveAdminExtensions(
  extensions: readonly AdminExtension[],
  ctx: AdminExtensionContext,
): ResolvedAdminExtensions {
  const services = extensions.map((ext) => ext.services?.(ctx) ?? {});
  const collect = <T>(hook: (ext: AdminExtension) => T[] | undefined): T[] =>
    extensions.flatMap((ext) => hook(ext) ?? []);
  const apiRoutes = collect((ext) => ext.apiRoutes?.(ctx));
  const adminUiRoutes = collect((ext) => ext.adminUiRoutes?.(ctx));
  const agentDetailCards = collect((ext) => ext.agentDetailCards?.(ctx));
  const backgroundPasses = collect((ext) => ext.backgroundPasses?.(ctx));
  const agentPhaseMethodologyService = services
    .map((s) => s.agentPhaseMethodologyService)
    .filter((svc) => svc !== undefined)
    .at(-1);
  return {
    ...(agentPhaseMethodologyService ? { agentPhaseMethodologyService } : {}),
    apiDeps: Object.assign({}, ...services.map((s) => s.api ?? {})),
    uiDeps: Object.assign({}, ...services.map((s) => s.ui ?? {})),
    apiRoutes,
    adminUiRoutes,
    agentDetailCards,
    backgroundPasses,
  };
}

/**
 * Merges every extension's static OpenAPI contribution, in order. Placements
 * are included only when some extension declared one.
 */
export function collectOpenApiContributions(
  extensions: readonly AdminExtension[],
): Required<Pick<AdminOpenApiContribution, "paths" | "schemas">> &
  Pick<AdminOpenApiContribution, "placeAfter"> {
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = {};
  const pathsAfter: Record<string, string> = {};
  const schemasAfter: Record<string, string> = {};
  for (const ext of extensions) {
    const contribution = ext.openApi?.() ?? {};
    for (const [path, methods] of Object.entries(contribution.paths ?? {})) {
      paths[path] = { ...paths[path], ...methods };
    }
    Object.assign(schemas, contribution.schemas);
    Object.assign(pathsAfter, contribution.placeAfter?.paths);
    Object.assign(schemasAfter, contribution.placeAfter?.schemas);
  }
  const placed =
    Object.keys(pathsAfter).length > 0 || Object.keys(schemasAfter).length > 0;
  return {
    paths,
    schemas,
    ...(placed
      ? { placeAfter: { paths: pathsAfter, schemas: schemasAfter } }
      : {}),
  };
}

/**
 * Merges `extra` into `base` keeping base's key order: an existing key keeps
 * its position (its value merged via `mergeValue`), a new key is inserted
 * right after its `after` anchor or, unplaced, appended. An anchor that is not
 * in the document is a programming error and throws.
 */
function mergeOrdered<V>(
  base: Record<string, V>,
  extra: Record<string, V>,
  after: Record<string, string> | undefined,
  mergeValue: (existing: V, added: V) => V,
): Record<string, V> {
  const keys = Object.keys(base);
  const values: Record<string, V> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (Object.hasOwn(values, key)) {
      values[key] = mergeValue(values[key] as V, value);
      continue;
    }
    const anchor = after?.[key];
    if (anchor === undefined) {
      keys.push(key);
    } else {
      const at = keys.indexOf(anchor);
      if (at === -1) {
        throw new Error(
          `OpenAPI contribution places "${key}" after unknown "${anchor}"`,
        );
      }
      keys.splice(at + 1, 0, key);
    }
    values[key] = value;
  }
  return Object.fromEntries(keys.map((key) => [key, values[key] as V]));
}

interface OpenApiDocLike {
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
}

/**
 * Folds a contribution into an OpenAPI document. An empty contribution returns
 * the input itself, so the generated spec stays byte-identical. Paths merge at
 * the method level (like the runtime/admin merge in generate-admin-spec.ts);
 * new paths and schemas land at their `placeAfter` anchors, else at the end.
 */
export function applyOpenApiContributions<T extends OpenApiDocLike>(
  doc: T,
  contribution: AdminOpenApiContribution,
): T {
  const extraPaths = Object.entries(contribution.paths ?? {});
  const extraSchemas = contribution.schemas ?? {};
  if (extraPaths.length === 0 && Object.keys(extraSchemas).length === 0) {
    return doc;
  }
  const paths = mergeOrdered(
    doc.paths ?? {},
    Object.fromEntries(extraPaths),
    contribution.placeAfter?.paths,
    (existing, added) => ({ ...existing, ...added }),
  );
  const schemas = mergeOrdered(
    doc.components?.schemas ?? {},
    extraSchemas,
    contribution.placeAfter?.schemas,
    (_existing, added) => added,
  );
  return {
    ...doc,
    paths,
    components: { ...(doc.components ?? {}), schemas },
  };
}

/**
 * Collects every extension's service integrations, in extension order. Resolved
 * before the provisioner exists, so it sees only the environment.
 */
export function collectServiceIntegrations(
  extensions: readonly AdminExtension[],
  env: NodeJS.ProcessEnv,
): ServiceIntegration[] {
  return extensions.flatMap((ext) => ext.serviceIntegrations?.(env) ?? []);
}

/** Mounts each contribution on root, in order. */
export function mountRouteContributions(
  root: AnyHono,
  routes: readonly AdminRouteContribution[],
): void {
  for (const { path, app } of routes) {
    root.route(path, app);
  }
}

export interface BackgroundPassRuntime {
  schedule(fn: () => void, intervalMs: number): unknown;
  log(message: string): void;
  error(...args: unknown[]): void;
}

const defaultRuntime: BackgroundPassRuntime = {
  schedule: (fn, intervalMs) => setInterval(fn, intervalMs),
  log: (message) => console.log(message),
  error: (...args) => console.error(...args),
};

/**
 * Starts each pass on its own interval, same shape as the platform sweepers:
 * a failing tick is logged with the pass's prefix and never throws.
 */
export function startBackgroundPasses(
  passes: readonly AdminBackgroundPass[],
  runtime: BackgroundPassRuntime = defaultRuntime,
): void {
  for (const pass of passes) {
    runtime.schedule(() => {
      pass
        .tick()
        .catch((err) => runtime.error(`${pass.logPrefix} tick error:`, err));
    }, pass.intervalMs);
    runtime.log(
      `[admin] ${pass.name} started (interval: ${pass.intervalMs}ms)`,
    );
  }
}

/** Renders card slots in order; a throwing slot is logged and omitted. */
export async function renderAgentDetailCards(
  slots: readonly AgentDetailCardSlot[],
  ctx: AgentDetailCardContext,
): Promise<string[]> {
  const rendered = await Promise.all(
    slots.map((slot) =>
      slot.render(ctx).catch((err) => {
        console.error(
          `[admin] agent detail card "${slot.name}" failed to render:`,
          err,
        );
        return undefined;
      }),
    ),
  );
  return rendered.filter((html): html is string => html !== undefined);
}

/**
 * Renders the slots (renderAgentDetailCards semantics: in order, a throwing
 * slot omitted) and groups the HTML by placement. Slots whose placement is not
 * in `placements` are not rendered: each holds its place as an empty string,
 * so the page lays out exactly as a full render whose cards came back empty.
 */
export async function renderAgentDetailCardSlots(
  slots: readonly AgentDetailCardSlot[],
  ctx: AgentDetailCardContext,
  placements: readonly AgentDetailCardPlacement[] = ["header", "configuration"],
): Promise<Record<AgentDetailCardPlacement, string[]>> {
  const at = async (placement: AgentDetailCardPlacement) => {
    const placed = slots.filter(
      (slot) => (slot.placement ?? "header") === placement,
    );
    return placements.includes(placement)
      ? renderAgentDetailCards(placed, ctx)
      : placed.map(() => "");
  };
  const [header, configuration] = await Promise.all([
    at("header"),
    at("configuration"),
  ]);
  return { header, configuration };
}
