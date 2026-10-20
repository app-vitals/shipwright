/**
 * admin/src/anthropic-federated-token-provider.ts
 * Signs the admin pod in to the Anthropic API by workload identity federation.
 *
 * The pod's Kubernetes projected ServiceAccount token (a JWT at a configurable
 * file path, rotated by the kubelet) is exchanged for a short-lived Anthropic
 * access token via POST /v1/oauth/token. The wire format mirrors what the
 * Anthropic SDK itself sends for federation: an RFC 7523 jwt-bearer grant that
 * names the federation rule and organization.
 *
 * KNOWN GAP: POST /v1/oauth/token is not in the Anthropic OpenAPI spec that the
 * rest of this client's fixtures are validated against, so this exchange is
 * covered only by the FakeAnthropicTokenExchange test double
 * (anthropic-identity-client.fixtures.ts).
 *
 * Secrets: neither the projected token nor the access token is ever logged or
 * placed in an error message. Error bodies from the token endpoint are reduced
 * to the RFC 6749 section 5.2 `error` code; everything else (which may echo
 * the assertion) is dropped.
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { type Clock, SystemClock } from "./clock.ts";

export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const TOKEN_PATH = "/v1/oauth/token";
const GRANT_TYPE_JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const OAUTH_API_BETA = "oauth-2025-04-20";
const FEDERATION_BETA = "oidc-federation-2026-04-01";
/** Token endpoint rejects assertions over 16 KiB. */
const MAX_ASSERTION_BYTES = 16 * 1024;
/** Refresh this long before the token actually expires. */
const DEFAULT_REFRESH_SKEW_SECONDS = 60;

export interface AnthropicAccessTokenProvider {
  /** A currently valid access token (exchanged on demand, cached). */
  getAccessToken(): Promise<string>;
  /** Drop the cached token, e.g. after the API answered 401. */
  invalidate(): void;
}

export class AnthropicTokenExchangeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "AnthropicTokenExchangeError";
  }
}

export interface FederatedTokenProviderOptions {
  fetchFn: typeof fetch;
  /** Path of the projected ServiceAccount token file. */
  tokenFilePath: string;
  federationRuleId: string;
  organizationId: string;
  serviceAccountId?: string;
  workspaceId?: string;
  baseUrl?: string;
  clock?: Clock;
  refreshSkewSeconds?: number;
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().positive(),
});

const TokenErrorBody = z.object({ error: z.string() });

function requireSecureBaseUrl(baseUrl: string): void {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new AnthropicTokenExchangeError(
      "Anthropic base URL is not a valid URL",
    );
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new AnthropicTokenExchangeError(
      "Refusing to send a credential to a non-https Anthropic token endpoint",
    );
  }
}

export class FederatedTokenProvider implements AnthropicAccessTokenProvider {
  private readonly clock: Clock;
  private readonly baseUrl: string;
  private readonly skewMs: number;
  private cached: { token: string; refreshAtMs: number } | null = null;
  private inflight: Promise<string> | null = null;
  private generation = 0;

  constructor(private readonly opts: FederatedTokenProviderOptions) {
    this.clock = opts.clock ?? SystemClock();
    this.baseUrl = (opts.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.skewMs =
      (opts.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS) * 1000;
  }

  async getAccessToken(): Promise<string> {
    if (this.cached && this.clock.now().getTime() < this.cached.refreshAtMs) {
      return this.cached.token;
    }
    if (!this.inflight) {
      const generation = this.generation;
      const pending = this.exchange(generation).finally(() => {
        if (this.inflight === pending) this.inflight = null;
      });
      this.inflight = pending;
    }
    return this.inflight;
  }

  invalidate(): void {
    this.cached = null;
    this.generation++;
  }

  private async readProjectedToken(): Promise<string> {
    let raw: string;
    try {
      raw = await readFile(this.opts.tokenFilePath, "utf-8");
    } catch (err) {
      const code = (err as { code?: string }).code ?? "unknown";
      throw new AnthropicTokenExchangeError(
        `Failed to read projected token file at ${this.opts.tokenFilePath} (${code})`,
      );
    }
    const jwt = raw.trim();
    if (!jwt) {
      throw new AnthropicTokenExchangeError(
        `Projected token file at ${this.opts.tokenFilePath} is empty`,
      );
    }
    if (Buffer.byteLength(jwt) > MAX_ASSERTION_BYTES) {
      throw new AnthropicTokenExchangeError(
        "Projected token exceeds the 16 KiB assertion limit",
      );
    }
    return jwt;
  }

  private async exchange(generation: number): Promise<string> {
    requireSecureBaseUrl(this.baseUrl);
    // Re-read on every exchange: the kubelet rotates the projected token.
    const assertion = await this.readProjectedToken();

    const body: Record<string, string> = {
      grant_type: GRANT_TYPE_JWT_BEARER,
      assertion,
      federation_rule_id: this.opts.federationRuleId,
      organization_id: this.opts.organizationId,
    };
    if (this.opts.serviceAccountId) {
      body.service_account_id = this.opts.serviceAccountId;
    }
    if (this.opts.workspaceId) body.workspace_id = this.opts.workspaceId;

    let resp: Response;
    try {
      resp = await this.opts.fetchFn(`${this.baseUrl}${TOKEN_PATH}`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          "anthropic-beta": `${OAUTH_API_BETA},${FEDERATION_BETA}`,
        },
        body: JSON.stringify(body),
      });
    } catch {
      // The underlying error text could echo request details; drop it.
      throw new AnthropicTokenExchangeError(
        "Anthropic token exchange request failed (network error)",
      );
    }

    const requestId = resp.headers.get("Request-Id") ?? undefined;
    const text = await resp.text().catch(() => "");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }

    if (!resp.ok) {
      const parsed = TokenErrorBody.safeParse(json);
      const code = parsed.success ? parsed.data.error : undefined;
      throw new AnthropicTokenExchangeError(
        `Anthropic token exchange failed with status ${resp.status}${
          code ? ` (${code})` : ""
        }${requestId ? ` (request-id ${requestId})` : ""}`,
        resp.status,
        code,
        requestId,
      );
    }

    if (json === undefined) {
      throw new AnthropicTokenExchangeError(
        "Anthropic token exchange response was not valid JSON",
        resp.status,
        undefined,
        requestId,
      );
    }
    const parsed = TokenResponse.safeParse(json);
    if (!parsed.success) {
      throw new AnthropicTokenExchangeError(
        "Anthropic token exchange response failed schema validation",
        resp.status,
        undefined,
        requestId,
      );
    }
    const { access_token, token_type, expires_in } = parsed.data;
    if (token_type && token_type.toLowerCase() !== "bearer") {
      throw new AnthropicTokenExchangeError(
        "Anthropic token exchange returned an unsupported token_type",
        resp.status,
        undefined,
        requestId,
      );
    }

    // A token minted before invalidate() was called is not cached.
    if (generation === this.generation) {
      this.cached = {
        token: access_token,
        refreshAtMs:
          this.clock.now().getTime() + expires_in * 1000 - this.skewMs,
      };
    }
    return access_token;
  }
}
