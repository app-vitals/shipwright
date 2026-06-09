/**
 * admin/src/google-auth-client.ts
 * Typed client for Google OAuth2 token exchange and user profile lookup.
 *
 * Interface + HTTP implementation following the project's client DI pattern.
 * Tests inject a mock implementation; production uses HttpGoogleAuthClient.
 */

// ─── Constants ──────────────────────────────────────────────────────────────

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GoogleTokenResponse {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn: number;
}

export interface GoogleUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name: string;
  picture?: string;
}

// ─── Interface ──────────────────────────────────────────────────────────────

export interface GoogleAuthClient {
  exchangeCode(params: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): Promise<GoogleTokenResponse>;

  getUserInfo(accessToken: string): Promise<GoogleUserInfo>;
}

// ─── Error ──────────────────────────────────────────────────────────────────

class GoogleAuthClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "GoogleAuthClientError";
  }
}

// ─── HTTP implementation ────────────────────────────────────────────────────

export class HttpGoogleAuthClient implements GoogleAuthClient {
  async exchangeCode(params: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): Promise<GoogleTokenResponse> {
    const res = await fetch(GOOGLE_TOKEN_URL, {
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
      throw new GoogleAuthClientError(
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

  async getUserInfo(accessToken: string): Promise<GoogleUserInfo> {
    const res = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new GoogleAuthClientError(
        `Userinfo fetch failed: ${res.status} ${body}`,
        res.status,
      );
    }

    return (await res.json()) as GoogleUserInfo;
  }
}
