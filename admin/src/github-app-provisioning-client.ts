/**
 * admin/src/github-app-provisioning-client.ts
 * GithubAppProvisioningClient interface and HttpGithubAppProvisioningClient
 * implementation.
 *
 * Used during the one-time agent provisioning flow:
 *   1. Redirect the user through GitHub's "create a GitHub App from a
 *      manifest" flow (https://docs.github.com/apps/creating-github-apps/setting-up-a-github-app/creating-a-github-app-from-a-manifest)
 *   2. GitHub redirects back with a one-time `code`.
 *   3. exchangeManifestCode(code) — POST app-manifests/{code}/conversions
 *      (unauthenticated) — returns the new app's credentials directly.
 *
 * The conversion response also includes a `webhook_secret` field. This
 * codebase has no webhook receiver, so it is intentionally discarded — never
 * stored, never returned.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GithubAppManifest {
  name: string;
  public: boolean;
  default_permissions: {
    contents: "write";
    pull_requests: "write";
    actions: "read";
    workflows: "write";
  };
  redirect_url?: string;
  setup_url?: string;
}

// ─── Interface ────────────────────────────────────────────────────────────────

export interface GithubAppProvisioningClient {
  /**
   * Call POST app-manifests/{code}/conversions with the one-time code GitHub
   * redirected back with after the manifest-based app creation flow.
   * Unauthenticated per GitHub's docs. Returns the new app's ID, slug, and
   * credentials — `webhook_secret` is discarded, never returned.
   */
  exchangeManifestCode(code: string): Promise<{
    appId: string;
    slug: string;
    pem: string;
    clientId: string;
    clientSecret: string;
  }>;
}

// ─── Agent manifest ───────────────────────────────────────────────────────────

/**
 * Builds the GitHub App manifest for a Shipwright agent.
 *
 * Used during the manifest-based app creation flow. `redirectUri` is where
 * GitHub sends the user after app creation (manifest flow's `redirect_url`,
 * distinct from the OAuth `callback_urls`). `setupUrl` is where the user
 * lands after installing the app (`setup_url`). Both are omitted when not
 * provided.
 *
 * No `hook_attributes` is set — no webhook receiver exists in this codebase.
 */
export function buildAgentAppManifest(
  appName: string,
  opts?: { redirectUri?: string; setupUrl?: string },
): GithubAppManifest {
  return {
    name: appName,
    public: false,
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      actions: "read",
      workflows: "write",
    },
    ...(opts?.redirectUri !== undefined
      ? { redirect_url: opts.redirectUri }
      : {}),
    ...(opts?.setupUrl !== undefined ? { setup_url: opts.setupUrl } : {}),
  };
}

// ─── HTTP implementation ──────────────────────────────────────────────────────

/**
 * Production implementation — calls the real GitHub API.
 *
 * The constructor takes optional apiBase/fetchFn overrides for testability.
 */
export class HttpGithubAppProvisioningClient
  implements GithubAppProvisioningClient
{
  private readonly apiBase: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts?: { apiBase?: string; fetchFn?: typeof fetch }) {
    this.apiBase = opts?.apiBase ?? "https://api.github.com";
    this.fetchFn = opts?.fetchFn ?? fetch;
  }

  async exchangeManifestCode(code: string): Promise<{
    appId: string;
    slug: string;
    pem: string;
    clientId: string;
    clientSecret: string;
  }> {
    const url = `${this.apiBase}/app-manifests/${code}/conversions`;

    // Unauthenticated per GitHub's docs — no Authorization header.
    const resp = await this.fetchFn(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
      },
    });

    if (!resp.ok) {
      throw new Error(
        `GitHub app-manifests conversion HTTP error: ${resp.status} ${resp.statusText}`,
      );
    }

    const data = (await resp.json()) as {
      id?: number;
      slug?: string;
      pem?: string;
      client_id?: string;
      client_secret?: string;
      // Present in GitHub's real response but intentionally never read —
      // no webhook receiver exists in this codebase, so webhook_secret must
      // never be stored or returned.
      webhook_secret?: string;
    };
    const { id, slug, pem, client_id, client_secret } = data;

    if (id === undefined || !slug || !pem || !client_id || !client_secret) {
      throw new Error(
        "GitHub app-manifests conversion response missing one or more required fields (id, slug, pem, client_id, client_secret)",
      );
    }

    return {
      appId: String(id),
      slug,
      pem,
      clientId: client_id,
      clientSecret: client_secret,
    };
  }
}
