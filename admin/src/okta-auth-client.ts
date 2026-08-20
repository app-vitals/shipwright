/**
 * admin/src/okta-auth-client.ts
 * Typed client for Okta OIDC authorization, token exchange, and user profile
 * lookup.
 *
 * Interface + HTTP implementation following the project's client DI pattern
 * (mirrors google-auth-client.ts). Endpoints are derived from a
 * caller-supplied issuer URL using Okta's well-known endpoint conventions
 * ({issuer}/v1/authorize, /v1/token, /v1/userinfo) — no live
 * `Issuer.discover()` `.well-known` network call happens, so construction is
 * fully synchronous and side-effect free. Tests inject a mock fetchFn;
 * production uses HttpOktaAuthClient with the real global fetch.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OktaTokenResponse {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn: number;
}

export interface OktaUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name: string;
  picture?: string;
}

// ─── Interface ──────────────────────────────────────────────────────────────

export interface OktaAuthClient {
  getAuthorizationUrl(params: {
    clientId: string;
    redirectUri: string;
    state: string;
    scope?: string;
  }): string;

  exchangeCode(params: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): Promise<OktaTokenResponse>;

  getUserInfo(accessToken: string): Promise<OktaUserInfo>;
}

// ─── Error ──────────────────────────────────────────────────────────────────

class OktaAuthClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "OktaAuthClientError";
  }
}

// ─── HTTP implementation ────────────────────────────────────────────────────

const DEFAULT_SCOPE = "openid profile email";

export class HttpOktaAuthClient implements OktaAuthClient {
  private readonly issuer: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: { issuer: string; fetchFn?: typeof fetch }) {
    // Normalize away a trailing slash so `${issuer}/v1/...` never produces a
    // double slash, regardless of how the issuer was configured.
    this.issuer = opts.issuer.replace(/\/+$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  getAuthorizationUrl(params: {
    clientId: string;
    redirectUri: string;
    state: string;
    scope?: string;
  }): string {
    const query = new URLSearchParams({
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      response_type: "code",
      scope: params.scope ?? DEFAULT_SCOPE,
      state: params.state,
    });

    return `${this.issuer}/v1/authorize?${query.toString()}`;
  }

  async exchangeCode(params: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): Promise<OktaTokenResponse> {
    const res = await this.fetchFn(`${this.issuer}/v1/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: params.code,
        client_id: params.clientId,
        client_secret: params.clientSecret,
        redirect_uri: params.redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new OktaAuthClientError(
        `Token exchange failed: ${res.status} ${body}`,
        res.status,
      );
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      id_token?: string;
      expires_in: number;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken: data.id_token,
      expiresIn: data.expires_in,
    };
  }

  async getUserInfo(accessToken: string): Promise<OktaUserInfo> {
    const res = await this.fetchFn(`${this.issuer}/v1/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new OktaAuthClientError(
        `Userinfo fetch failed: ${res.status} ${body}`,
        res.status,
      );
    }

    return (await res.json()) as OktaUserInfo;
  }
}
