/**
 * agent/src/github-app-auth.ts
 *
 * GitHub App authentication module.
 *
 * Provides installation-token management with caching and proactive refresh,
 * plus a one-shot lookup of the App's bot identity (for git author config).
 * Built for dependency injection so it's testable.
 */

import { createAppAuth } from "@octokit/auth-app";

// ─── Types ────────────────────────────────────────────────────────────────────

interface InstallationAuthResult {
  token: string;
  expiresAt: string;
  type: string;
  tokenType: string;
}

type AuthFunction = (params?: {
  type: string;
  installationId?: number;
}) => Promise<InstallationAuthResult>;

export interface BotIdentity {
  slug: string;
  name: string;
  userId: number;
}

export type FetchFn = typeof fetch;

// ─── GitHubTokenManager ───────────────────────────────────────────────────────

interface TokenCache {
  token: string;
  expiresAt: Date;
}

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes
const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export class GitHubTokenManager {
  auth: AuthFunction;
  private readonly installationId: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private cache: TokenCache | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: {
    auth: AuthFunction;
    installationId: number;
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
  }) {
    this.auth = opts.auth;
    this.installationId = opts.installationId;
    this.setIntervalFn = opts.setIntervalFn ?? setInterval;
    this.clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
  }

  async getToken(): Promise<string> {
    if (this.cache && !this.isNearExpiry(this.cache.expiresAt)) {
      return this.cache.token;
    }

    const result = await this.auth({
      type: "installation",
      installationId: this.installationId,
    });

    this.cache = {
      token: result.token,
      expiresAt: new Date(result.expiresAt),
    };

    return result.token;
  }

  startBackgroundRefresh(onRefresh: (token: string) => Promise<void>): void {
    this.stopBackgroundRefresh();

    this.refreshTimer = this.setIntervalFn(async () => {
      try {
        const token = await this.refreshToken();
        await onRefresh(token);
      } catch (err) {
        console.error("[github-app-auth] background refresh failed:", err);
      }
    }, REFRESH_INTERVAL_MS);
  }

  stopBackgroundRefresh(): void {
    if (this.refreshTimer !== null) {
      this.clearIntervalFn(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private isNearExpiry(expiresAt: Date): boolean {
    return expiresAt.getTime() - Date.now() <= REFRESH_BUFFER_MS;
  }

  private async refreshToken(): Promise<string> {
    this.cache = null;
    return this.getToken();
  }
}

export function createGitHubTokenManager(): GitHubTokenManager {
  const appId = process.env.GH_APP_ID;
  const privateKey = process.env.GH_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const installationId = Number(process.env.GH_APP_INSTALLATION_ID);

  if (!appId || !privateKey || !installationId) {
    throw new Error(
      "Missing required env vars: GH_APP_ID, GH_APP_PRIVATE_KEY, GH_APP_INSTALLATION_ID",
    );
  }

  const appAuth = createAppAuth({ appId, privateKey });
  const auth: AuthFunction = async (params) =>
    appAuth(
      params as Parameters<typeof appAuth>[0],
    ) as Promise<InstallationAuthResult>;

  return new GitHubTokenManager({ auth, installationId });
}

async function fetchBotIdentity(
  appId: string,
  privateKey: string,
  fetchFn: FetchFn = fetch,
): Promise<BotIdentity> {
  const appAuth = createAppAuth({ appId, privateKey });
  const { token: jwt } = (await appAuth({ type: "app" })) as { token: string };

  const headers = {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const appResp = await fetchFn("https://api.github.com/app", { headers });
  if (!appResp.ok) {
    throw new Error(
      `GET /app failed: ${appResp.status} ${appResp.statusText}`,
    );
  }
  const { slug, name } = (await appResp.json()) as {
    slug: string;
    name: string;
  };

  const userUrl = `https://api.github.com/users/${encodeURIComponent(`${slug}[bot]`)}`;
  const userResp = await fetchFn(userUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!userResp.ok) {
    throw new Error(
      `GET /users/${slug}[bot] failed: ${userResp.status} ${userResp.statusText}`,
    );
  }
  const { id: userId } = (await userResp.json()) as { id: number };

  return { slug, name, userId };
}

export function getBotIdentity(): Promise<BotIdentity> {
  const appId = process.env.GH_APP_ID;
  const privateKey = process.env.GH_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!appId || !privateKey) {
    throw new Error("Missing required env vars: GH_APP_ID, GH_APP_PRIVATE_KEY");
  }

  return fetchBotIdentity(appId, privateKey);
}
