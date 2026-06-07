/**
 * metrics/src/secrets.ts
 * GCP Secret Manager client with env var fallback for local dev.
 * Uses dependency injection for the SecretManager client (testable without real GCP).
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
 * Creates a secrets client that resolves secrets from GCP Secret Manager,
 * falling back to environment variables when GCP is unavailable (local dev).
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
   * Order: GCP Secret Manager → process.env[name] → throw SecretNotFoundError
   */
  async function getSecret(name: string): Promise<string> {
    // Try GCP Secret Manager first
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
      // Fall back to env var if GCP is unavailable (local dev, missing credentials, etc.)
      // Re-throw if it's our own error (secret explicitly missing from GCP)
      if (err instanceof SecretNotFoundError) throw err;

      const envValue = process.env[name];
      if (envValue !== undefined) return envValue;

      throw new SecretNotFoundError(
        name,
        err instanceof Error ? err : undefined,
      );
    }
  }

  return { getSecret };
}

export type SecretsClient = ReturnType<typeof createSecretsClient>;
