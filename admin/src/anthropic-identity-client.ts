/**
 * admin/src/anthropic-identity-client.ts
 * AnthropicIdentityClient interface and HttpAnthropicIdentityClient
 * implementation (PAI-1.5).
 *
 * Manages the Anthropic-side identity of a Shipwright agent through the
 * Anthropic Admin API, using the typed resources of @anthropic-ai/sdk:
 *
 *   createServiceAccount          POST /v1/organizations/service_accounts
 *   addServiceAccountToWorkspace  POST /v1/organizations/service_accounts/{id}/workspaces
 *   createFederationRule          POST /v1/organizations/federation_rules
 *   archiveFederationRule         POST /v1/organizations/federation_rules/{id}/archive
 *   archiveServiceAccount         POST /v1/organizations/service_accounts/{id}/archive
 *   findServiceAccountByName      GET  /v1/organizations/service_accounts      (paged)
 *   findFederationRuleByName      GET  /v1/organizations/federation_rules      (paged)
 *
 * What the issue calls a "rule" is the spec's federation rule. The list
 * endpoints have no name filter, so the find-by-name fallbacks follow the
 * `next_page` cursor until it is exhausted.
 *
 * Auth: the admin pod signs in by federation (FederatedTokenProvider); the
 * exchanged access token is sent as a bearer token. The SDK is built with the
 * injected `fetchFn`, so tests replay recorded fixtures with no global
 * override.
 *
 * Trust boundary: every response body is parsed with zod before any field is
 * used. Secrets: no token or Authorization header is ever logged or placed in
 * an error message (SDK logging is off and SDK errors are re-mapped to
 * status / error type / request id only).
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  type AnthropicAccessTokenProvider,
  DEFAULT_ANTHROPIC_BASE_URL,
  OAUTH_API_BETA,
} from "./anthropic-federated-token-provider.ts";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface AnthropicServiceAccount {
  id: string;
  name: string;
  /** ISO timestamp, or null while the service account is live. */
  archivedAt: string | null;
}

export interface AnthropicFederationRule {
  id: string;
  name: string;
  archivedAt: string | null;
}

export interface AnthropicWorkspaceMember {
  serviceAccountId: string;
  workspaceId: string;
  workspaceRole: string;
}

export type AnthropicWorkspaceRole =
  | "workspace_admin"
  | "workspace_developer"
  | "workspace_restricted_developer"
  | "workspace_user";

export interface CreateServiceAccountInput {
  name: string;
  description?: string;
}

export interface AddServiceAccountToWorkspaceInput {
  serviceAccountId: string;
  workspaceId: string;
  /** Defaults to workspace_developer. */
  workspaceRole?: AnthropicWorkspaceRole;
}

export interface CreateFederationRuleInput {
  name: string;
  description?: string;
  /** Federation issuer (`fdis_...`) the rule matches tokens from. */
  issuerId: string;
  /** Service account (`svac_...`) the rule mints tokens for. */
  serviceAccountId: string;
  workspaceId?: string;
  /** Defaults to workspace:developer. */
  oauthScope?: string;
  match: {
    subjectPrefix?: string;
    audience?: string;
    condition?: string;
  };
  tokenLifetimeSeconds?: number;
}

export interface AnthropicIdentityClient {
  createServiceAccount(
    input: CreateServiceAccountInput,
  ): Promise<AnthropicServiceAccount>;
  addServiceAccountToWorkspace(
    input: AddServiceAccountToWorkspaceInput,
  ): Promise<AnthropicWorkspaceMember>;
  createFederationRule(
    input: CreateFederationRuleInput,
  ): Promise<AnthropicFederationRule>;
  archiveFederationRule(ruleId: string): Promise<AnthropicFederationRule>;
  archiveServiceAccount(
    serviceAccountId: string,
  ): Promise<AnthropicServiceAccount>;
  /** Live (non-archived) service account with exactly this name, or null. */
  findServiceAccountByName(
    name: string,
  ): Promise<AnthropicServiceAccount | null>;
  /** Live (non-archived) federation rule with exactly this name, or null. */
  findFederationRuleByName(
    name: string,
  ): Promise<AnthropicFederationRule | null>;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/** An Anthropic API call failed. Carries no body text, only safe metadata. */
export class AnthropicApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number | undefined,
    readonly errorType?: string,
    readonly requestId?: string,
  ) {
    super(
      `Anthropic ${operation} failed${status ? ` with status ${status}` : " (network error)"}${
        errorType ? ` (${errorType})` : ""
      }${requestId ? ` (request-id ${requestId})` : ""}`,
    );
    this.name = "AnthropicApiError";
  }
}

/** 409: a resource with that name already exists. Fall back to find-by-name. */
export class AnthropicConflictError extends AnthropicApiError {
  constructor(operation: string, errorType?: string, requestId?: string) {
    super(operation, 409, errorType, requestId);
    this.name = "AnthropicConflictError";
  }
}

/** 401 that persisted after one token re-exchange. */
export class AnthropicAuthError extends AnthropicApiError {
  constructor(operation: string, errorType?: string, requestId?: string) {
    super(operation, 401, errorType, requestId);
    this.name = "AnthropicAuthError";
  }
}

/** A response body did not match the expected schema (body is never echoed). */
export class AnthropicResponseValidationError extends Error {
  constructor(
    readonly operation: string,
    detail: string,
  ) {
    super(`Anthropic ${operation} returned an invalid response: ${detail}`);
    this.name = "AnthropicResponseValidationError";
  }
}

// ─── Response schemas (trust boundary) ────────────────────────────────────────

/** Service accounts and federation rules share this shape. */
const NamedResourceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  archived_at: z.string().nullable(),
});

const WorkspaceMemberSchema = z.object({
  service_account_id: z.string().min(1),
  workspace_id: z.string().min(1),
  workspace_role: z.string(),
});

const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), next_page: z.string().nullable() });

const ErrorBodySchema = z.object({
  request_id: z.string().nullish(),
  error: z.object({ type: z.string() }),
});

const toNamedResource = (
  r: z.infer<typeof NamedResourceSchema>,
): AnthropicServiceAccount & AnthropicFederationRule => ({
  id: r.id,
  name: r.name,
  archivedAt: r.archived_at,
});

// ─── Implementation ───────────────────────────────────────────────────────────

const PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface HttpAnthropicIdentityClientOptions {
  /** Injected fetch; used for every API call (tests replay recorded fixtures). */
  fetchFn: typeof fetch;
  tokenProvider: AnthropicAccessTokenProvider;
  baseUrl?: string;
  timeoutMs?: number;
}

type RawCall = (sdk: Anthropic) => { asResponse(): Promise<Response> };

export class HttpAnthropicIdentityClient implements AnthropicIdentityClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private sdkCache: { token: string; sdk: Anthropic } | null = null;

  constructor(private readonly opts: HttpAnthropicIdentityClientOptions) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // ── Interface ───────────────────────────────────────────────────────────────

  async createServiceAccount(
    input: CreateServiceAccountInput,
  ): Promise<AnthropicServiceAccount> {
    const sa = await this.request(
      "createServiceAccount",
      NamedResourceSchema,
      (sdk) =>
        sdk.organization.serviceAccounts.create({
          name: input.name,
          description: input.description,
          // A workload may only create developer-role service accounts.
          organization_role: "developer",
        }),
    );
    return toNamedResource(sa);
  }

  async addServiceAccountToWorkspace(
    input: AddServiceAccountToWorkspaceInput,
  ): Promise<AnthropicWorkspaceMember> {
    const m = await this.request(
      "addServiceAccountToWorkspace",
      WorkspaceMemberSchema,
      (sdk) =>
        sdk.organization.serviceAccounts.workspaces.add(
          input.serviceAccountId,
          {
            workspace_id: input.workspaceId,
            workspace_role: input.workspaceRole ?? "workspace_developer",
          },
        ),
    );
    return {
      serviceAccountId: m.service_account_id,
      workspaceId: m.workspace_id,
      workspaceRole: m.workspace_role,
    };
  }

  async createFederationRule(
    input: CreateFederationRuleInput,
  ): Promise<AnthropicFederationRule> {
    const rule = await this.request(
      "createFederationRule",
      NamedResourceSchema,
      (sdk) =>
        sdk.organization.federation.rules.create({
          // Undefined optionals are dropped by JSON serialization.
          name: input.name,
          description: input.description,
          issuer_id: input.issuerId,
          match: {
            subject_prefix: input.match.subjectPrefix,
            audience: input.match.audience,
            condition: input.match.condition,
          },
          oauth_scope: input.oauthScope ?? "workspace:developer",
          target: {
            type: "service_account",
            service_account_id: input.serviceAccountId,
          },
          workspace_id: input.workspaceId,
          token_lifetime_seconds: input.tokenLifetimeSeconds,
        }),
    );
    return toNamedResource(rule);
  }

  async archiveFederationRule(
    ruleId: string,
  ): Promise<AnthropicFederationRule> {
    const rule = await this.request(
      "archiveFederationRule",
      NamedResourceSchema,
      (sdk) => sdk.organization.federation.rules.archive(ruleId),
    );
    return toNamedResource(rule);
  }

  async archiveServiceAccount(
    serviceAccountId: string,
  ): Promise<AnthropicServiceAccount> {
    const sa = await this.request(
      "archiveServiceAccount",
      NamedResourceSchema,
      (sdk) => sdk.organization.serviceAccounts.archive(serviceAccountId),
    );
    return toNamedResource(sa);
  }

  async findServiceAccountByName(
    name: string,
  ): Promise<AnthropicServiceAccount | null> {
    const found = await this.findByName(
      "findServiceAccountByName",
      NamedResourceSchema,
      name,
      (sdk, page) =>
        sdk.organization.serviceAccounts.list({ limit: PAGE_SIZE, page }),
    );
    return found ? toNamedResource(found) : null;
  }

  async findFederationRuleByName(
    name: string,
  ): Promise<AnthropicFederationRule | null> {
    const found = await this.findByName(
      "findFederationRuleByName",
      NamedResourceSchema,
      name,
      (sdk, page) =>
        sdk.organization.federation.rules.list({ limit: PAGE_SIZE, page }),
    );
    return found ? toNamedResource(found) : null;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /**
   * The list endpoints have no name filter: walk every page via `next_page`
   * until the name is found or the cursor is exhausted. Archived entries are
   * skipped (they are excluded by default but checked defensively).
   */
  private async findByName<
    T extends z.ZodType<{ name: string; archived_at: string | null }>,
  >(
    operation: string,
    itemSchema: T,
    name: string,
    list: (sdk: Anthropic, page: string | undefined) => ReturnType<RawCall>,
  ): Promise<z.infer<T> | null> {
    const schema = pageOf(itemSchema);
    const seen = new Set<string>();
    let page: string | undefined;
    for (;;) {
      const cursor = page;
      const result = await this.request(operation, schema, (sdk) =>
        list(sdk, cursor),
      );
      const hit = result.data.find(
        (item) => item.name === name && item.archived_at === null,
      );
      if (hit) return hit;
      if (result.next_page === null) return null;
      if (seen.has(result.next_page)) {
        throw new AnthropicResponseValidationError(
          operation,
          "pagination cursor repeated",
        );
      }
      seen.add(result.next_page);
      page = result.next_page;
    }
  }

  /** The SDK client is rebuilt only when the access token changes. */
  private async sdk(): Promise<Anthropic> {
    const token = await this.opts.tokenProvider.getAccessToken();
    if (this.sdkCache?.token === token) return this.sdkCache.sdk;
    const sdk = new Anthropic({
      // Explicit null stops the SDK reading ANTHROPIC_API_KEY from the env,
      // which would outrank the federated bearer token.
      apiKey: null,
      authToken: token,
      baseURL: this.baseUrl,
      fetch: this.opts.fetchFn as unknown as NonNullable<
        ConstructorParameters<typeof Anthropic>[0]
      >["fetch"],
      // Retrying 409 would defeat duplicate-name detection; 401 is retried
      // here after a token re-exchange instead.
      maxRetries: 0,
      timeout: this.timeoutMs,
      logLevel: "off",
      defaultHeaders: { "anthropic-beta": OAUTH_API_BETA },
    });
    this.sdkCache = { token, sdk };
    return sdk;
  }

  /**
   * Run one SDK call, parse the raw JSON body with zod, and map failures to
   * typed errors. A 401 triggers exactly one token re-exchange and retry.
   */
  private async request<T extends z.ZodType>(
    operation: string,
    schema: T,
    call: RawCall,
  ): Promise<z.infer<T>> {
    for (let attempt = 0; ; attempt++) {
      const sdk = await this.sdk();
      let text: string;
      try {
        text = await (await call(sdk).asResponse()).text();
      } catch (err) {
        const mapped = mapError(operation, err);
        if (mapped instanceof AnthropicAuthError && attempt === 0) {
          this.opts.tokenProvider.invalidate();
          continue;
        }
        throw mapped;
      }
      return parseBody(operation, schema, text);
    }
  }
}

function parseBody<T extends z.ZodType>(
  operation: string,
  schema: T,
  text: string,
): z.infer<T> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AnthropicResponseValidationError(operation, "body is not JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    // Paths only: zod messages for values could echo response content.
    const paths = parsed.error.issues
      .map((i) => i.path.join(".") || "(root)")
      .join(", ");
    throw new AnthropicResponseValidationError(
      operation,
      `schema mismatch at ${paths}`,
    );
  }
  return parsed.data;
}

function mapError(operation: string, err: unknown): Error {
  if (!(err instanceof Anthropic.APIError)) {
    // Connection failures and timeouts: never surface the SDK message, which
    // can include the request URL and cause chain.
    return new AnthropicApiError(operation, undefined);
  }
  const body = ErrorBodySchema.safeParse(err.error);
  const errorType = body.success ? body.data.error.type : undefined;
  const bodyRequestId = body.success ? body.data.request_id : undefined;
  const requestId = bodyRequestId ?? err.requestID ?? undefined;
  if (err.status === 409) {
    return new AnthropicConflictError(operation, errorType, requestId);
  }
  if (err.status === 401) {
    return new AnthropicAuthError(operation, errorType, requestId);
  }
  return new AnthropicApiError(operation, err.status, errorType, requestId);
}
