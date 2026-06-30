/**
 * metrics/src/secrets.ts
 * Secrets client: env var first, GCP Secret Manager optional fallback.
 * Uses dependency injection for the SecretManager client (testable without real GCP).
 *
 * Resolution order:
 *   1. process.env[name]  — plain env var, works without GCP credentials
 *   2. GCP Secret Manager — optional, only tried when env var is absent
 */

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID ?? "";

/** Minimal interface for the GCP Secret Manager client — covers only what we need */
export interface SecretManagerClient {
  accessSecretVersion(request: {
    name: string;
  }): Promise<
    [
      { payload?: { data?: Buffer | Uint8Array | string | null } },
      unknown,
      unknown,
    ]
  >;
}

/** Factory that creates a SecretManagerClient — injectable for tests */
export type SecretManagerClientFactory = () => SecretManagerClient;

/** Error thrown when a secret cannot be resolved from any source */
export class SecretNotFoundError extends Error {
  constructor(name: string, cause?: Error) {
    super(
      `Secret '${name}' not found in GCP Secret Manager or environment variables`,
      { cause },
    );
    this.name = "SecretNotFoundError";
  }
}

/**
 * Creates a secrets client that resolves secrets env-first, with GCP Secret Manager
 * as an optional fallback when the env var is absent.
 *
 * @param gcpProjectId - GCP project ID (defaults to process.env.GCP_PROJECT_ID)
 * @param clientFactory - Optional factory for the GCP SecretManager client (DI for tests)
 */
export function createSecretsClient(
  gcpProjectId: string = GCP_PROJECT_ID,
  clientFactory?: SecretManagerClientFactory,
) {
  let _client: SecretManagerClient | null = null;

  function getClient(): SecretManagerClient {
    if (_client) return _client;

    if (clientFactory) {
      _client = clientFactory();
      return _client;
    }

    // Lazily import the real GCP client so the singleton is only created on first use
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {
      SecretManagerServiceClient,
    } = require("@google-cloud/secret-manager");
    _client =
      new SecretManagerServiceClient() as unknown as SecretManagerClient;
    return _client;
  }

  /**
   * Resolves a secret by name.
   * Order: process.env[name] → GCP Secret Manager → throw SecretNotFoundError
   *
   * Env var wins — supports plain API_KEY without GCP credentials.
   * GCP Secret Manager is optional: only tried when env var is absent.
   */
  async function getSecret(name: string): Promise<string> {
    // Env var wins — no GCP credentials required for plain env usage
    const envValue = process.env[name];
    if (envValue !== undefined) return envValue;

    // GCP Secret Manager — optional, only used when env var is absent
    try {
      const client = getClient();
      const secretName = `projects/${gcpProjectId}/secrets/${name}/versions/latest`;
      const [version] = await client.accessSecretVersion({ name: secretName });
      const data = version?.payload?.data;

      if (data == null) {
        throw new SecretNotFoundError(name);
      }

      if (typeof data === "string") return data;
      // Buffer / Uint8Array
      return Buffer.from(data).toString("utf8");
    } catch (err) {
      if (err instanceof SecretNotFoundError) throw err;
      throw new SecretNotFoundError(
        name,
        err instanceof Error ? err : undefined,
      );
    }
  }

  return { getSecret };
}

export type SecretsClient = ReturnType<typeof createSecretsClient>;
