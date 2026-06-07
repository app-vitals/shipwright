/**
 * metrics/src/secrets.test.ts
 * Tests for GCP Secret Manager secrets client — uses DI factory, no real GCP calls.
 */

import { describe, expect, it } from "bun:test";
import {
  type SecretManagerClient,
  SecretNotFoundError,
  createSecretsClient,
} from "./secrets.ts";

const TEST_PROJECT = "test-project-id";

/** Build a mock SecretManagerClient that returns a given payload or throws */
function mockSecretManager(
  behavior:
    | { type: "success"; value: string }
    | { type: "buffer"; value: Buffer }
    | { type: "null-payload" }
    | { type: "error"; error: Error },
): SecretManagerClient {
  return {
    async accessSecretVersion(_request) {
      if (behavior.type === "success") {
        return [{ payload: { data: behavior.value } }, {}, {}];
      }
      if (behavior.type === "buffer") {
        return [{ payload: { data: behavior.value } }, {}, {}];
      }
      if (behavior.type === "null-payload") {
        return [{ payload: { data: null } }, {}, {}];
      }
      throw behavior.error;
    },
  };
}

describe("createSecretsClient", () => {
  describe("getSecret — GCP success path", () => {
    it("returns string payload from GCP Secret Manager", async () => {
      const client = createSecretsClient(TEST_PROJECT, () =>
        mockSecretManager({ type: "success", value: "ph_test_abc123" }),
      );

      const value = await client.getSecret("posthog-personal-api-key");
      expect(value).toBe("ph_test_abc123");
    });

    it("decodes Buffer payload from GCP Secret Manager", async () => {
      const buffer = Buffer.from("ph_test_buffer_value", "utf8");
      const client = createSecretsClient(TEST_PROJECT, () =>
        mockSecretManager({ type: "buffer", value: buffer }),
      );

      const value = await client.getSecret("posthog-personal-api-key");
      expect(value).toBe("ph_test_buffer_value");
    });

    it("decodes Uint8Array payload from GCP Secret Manager", async () => {
      const uint8 = new TextEncoder().encode("ph_test_uint8_value");
      const client = createSecretsClient(TEST_PROJECT, () => ({
        async accessSecretVersion(_request) {
          return [{ payload: { data: uint8 } }, {}, {}];
        },
      }));

      const value = await client.getSecret("posthog-personal-api-key");
      expect(value).toBe("ph_test_uint8_value");
    });
  });

  describe("getSecret — env var fallback", () => {
    it("falls back to process.env when GCP client throws", async () => {
      const originalValue = process.env.TEST_SECRET_FALLBACK;
      process.env.TEST_SECRET_FALLBACK = "env-fallback-value";

      try {
        const client = createSecretsClient(TEST_PROJECT, () =>
          mockSecretManager({
            type: "error",
            error: new Error("GCP credentials not found"),
          }),
        );

        const value = await client.getSecret("TEST_SECRET_FALLBACK");
        expect(value).toBe("env-fallback-value");
      } finally {
        if (originalValue === undefined) {
          process.env.TEST_SECRET_FALLBACK = undefined;
        } else {
          process.env.TEST_SECRET_FALLBACK = originalValue;
        }
      }
    });

    it("falls back when GCP returns network error", async () => {
      const originalValue = process.env.TEST_NET_ERR_SECRET;
      process.env.TEST_NET_ERR_SECRET = "network-fallback-value";

      try {
        const client = createSecretsClient(TEST_PROJECT, () =>
          mockSecretManager({
            type: "error",
            error: new Error("ECONNREFUSED: Connection refused"),
          }),
        );

        const value = await client.getSecret("TEST_NET_ERR_SECRET");
        expect(value).toBe("network-fallback-value");
      } finally {
        if (originalValue === undefined) {
          process.env.TEST_NET_ERR_SECRET = undefined;
        } else {
          process.env.TEST_NET_ERR_SECRET = originalValue;
        }
      }
    });
  });

  describe("getSecret — SecretNotFoundError", () => {
    it("throws SecretNotFoundError when GCP throws and env var is missing", async () => {
      // Ensure this env var is definitely not set
      const envKey = "METRICS_MISSING_SECRET_XYZ_NOT_SET";
      delete process.env[envKey];

      const client = createSecretsClient(TEST_PROJECT, () =>
        mockSecretManager({
          type: "error",
          error: new Error("NOT_FOUND: secret not found"),
        }),
      );

      await expect(client.getSecret(envKey)).rejects.toBeInstanceOf(
        SecretNotFoundError,
      );
    });

    it("throws SecretNotFoundError with descriptive message", async () => {
      const envKey = "METRICS_MISSING_SECRET_XYZ_NOT_SET";
      delete process.env[envKey];

      const client = createSecretsClient(TEST_PROJECT, () =>
        mockSecretManager({
          type: "error",
          error: new Error("PERMISSION_DENIED"),
        }),
      );

      await expect(client.getSecret(envKey)).rejects.toThrow(
        "Secret 'METRICS_MISSING_SECRET_XYZ_NOT_SET' not found",
      );
    });

    it("throws SecretNotFoundError immediately when GCP returns null payload", async () => {
      const client = createSecretsClient(TEST_PROJECT, () =>
        mockSecretManager({ type: "null-payload" }),
      );

      await expect(
        client.getSecret("posthog-personal-api-key"),
      ).rejects.toBeInstanceOf(SecretNotFoundError);
    });
  });

  describe("SecretNotFoundError", () => {
    it("has correct name and message", () => {
      const err = new SecretNotFoundError("my-secret");
      expect(err.name).toBe("SecretNotFoundError");
      expect(err.message).toContain("my-secret");
      expect(err instanceof Error).toBe(true);
    });

    it("attaches the original GCP error as cause", async () => {
      const envKey = "METRICS_MISSING_SECRET_CAUSE_CHECK";
      delete process.env[envKey];

      const gcpError = new Error("PERMISSION_DENIED: caller lacks permission");
      const client = createSecretsClient(TEST_PROJECT, () =>
        mockSecretManager({ type: "error", error: gcpError }),
      );

      let thrown: unknown;
      try {
        await client.getSecret(envKey);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(SecretNotFoundError);
      expect((thrown as SecretNotFoundError).cause).toBe(gcpError);
    });
  });

  describe("createSecretsClient — real GCP client factory", () => {
    it("creates a real SecretManagerServiceClient when no factory is provided", async () => {
      // Exercises the require('@google-cloud/secret-manager') path (lines 58-63).
      // No factory = the lazy-init branch runs. In CI there are no GCP credentials,
      // so accessSecretVersion() throws — the env var fallback catches it, proving
      // the real client was constructed and the require() path was exercised.
      const envKey = "METRICS_GCP_CLIENT_PATH_TEST";
      process.env[envKey] = "real-client-fallback";
      let val: string;
      try {
        const client = createSecretsClient(TEST_PROJECT);
        val = await client.getSecret(envKey);
      } finally {
        delete process.env[envKey];
      }
      expect(val).toBe("real-client-fallback");
    });
  });

  describe("createSecretsClient — defaults", () => {
    it("uses GCP_PROJECT_ID env var (or empty string) as default GCP project", async () => {
      let capturedName = "";
      const client = createSecretsClient(undefined, () => ({
        async accessSecretVersion(req) {
          capturedName = req.name;
          return [{ payload: { data: "value" } }, {}, {}];
        },
      }));

      await client.getSecret("posthog-personal-api-key");
      expect(capturedName).toBe(
        "projects//secrets/posthog-personal-api-key/versions/latest",
      );
    });

    it("builds correct secret path from project and secret name", async () => {
      let capturedName = "";
      const client = createSecretsClient("my-project-123", () => ({
        async accessSecretVersion(req) {
          capturedName = req.name;
          return [{ payload: { data: "test-value" } }, {}, {}];
        },
      }));

      await client.getSecret("my-api-key");
      expect(capturedName).toBe(
        "projects/my-project-123/secrets/my-api-key/versions/latest",
      );
    });
  });
});
