/**
 * admin/src/admin-extension.ts
 *
 * The extension seam between the generic admin platform (admin-boot.ts:
 * agents, envs, crons, tokens, plugins, accounts, provisioning, the admin UI
 * shell and its sweepers) and agent-type-specific admin behavior (Shipwright:
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
  /** Web Push, present only when VAPID is fully configured. */
  push?: { service: PushService; maxDetail: string };
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
  return {
    apiDeps: Object.assign({}, ...services.map((s) => s.api ?? {})),
    uiDeps: Object.assign({}, ...services.map((s) => s.ui ?? {})),
    apiRoutes,
    adminUiRoutes,
    agentDetailCards,
    backgroundPasses,
  };
}

/** Merges every extension's static OpenAPI contribution, in order. */
export function collectOpenApiContributions(
  extensions: readonly AdminExtension[],
): Required<AdminOpenApiContribution> {
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = {};
  for (const ext of extensions) {
    const contribution = ext.openApi?.() ?? {};
    for (const [path, methods] of Object.entries(contribution.paths ?? {})) {
      paths[path] = { ...paths[path], ...methods };
    }
    Object.assign(schemas, contribution.schemas);
  }
  return { paths, schemas };
}

interface OpenApiDocLike {
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
}

/**
 * Folds a contribution into an OpenAPI document. An empty contribution returns
 * the input itself, so the generated spec stays byte-identical. Paths merge at
 * the method level (like the runtime/admin merge in generate-admin-spec.ts).
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
  const paths = { ...(doc.paths ?? {}) };
  for (const [path, methods] of extraPaths) {
    paths[path] = { ...paths[path], ...methods };
  }
  return {
    ...doc,
    paths,
    components: {
      ...(doc.components ?? {}),
      schemas: { ...(doc.components?.schemas ?? {}), ...extraSchemas },
    },
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
