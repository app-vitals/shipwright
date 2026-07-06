/**
 * admin/src/task-store-provisioning-client.ts
 *
 * Thin interface + implementations for minting/revoking per-agent task-store
 * tokens during agent provisioning.
 *
 * The interface is the DI boundary. Tests inject a stub; production wires in
 * HttpTaskStoreProvisioningClient (or skips task-store wiring entirely by
 * omitting the client from KubernetesAgentProvisionerConfig).
 */

// ─── Interface ───────────────────────────────────────────────────────────────

export interface TaskStoreProvisioningClient {
  /**
   * Mint a new task-store token. Returns the token `id` (needed to revoke it
   * on rollback) and the `rawToken` (stored in the agent Secret and later used
   * by the agent to authenticate with the task store).
   *
   * Pass `agentId` to create a scoped agent token — the task store will scope
   * all reads and writes to tasks assigned to this agent. Omit for admin tokens.
   */
  mintToken(
    label: string,
    agentId?: string,
  ): Promise<{ id: string; rawToken: string }>;

  /**
   * Revoke a previously-minted task-store token. Called as part of the rollback
   * path when Deployment creation fails after the token was minted.
   * Should be best-effort — callers do not propagate errors from this call.
   */
  revokeToken(id: string): Promise<void>;
}

// ─── HTTP implementation ──────────────────────────────────────────────────────

/**
 * Real HTTP client for the task-store token API.
 *
 * POST /tokens  → { id, rawToken, ... }
 * DELETE /tokens/:id
 *
 * The admin token is passed via Bearer auth and is never stored in the Secret
 * or handed to the agent — only the per-agent rawToken is.
 */
export class HttpTaskStoreProvisioningClient
  implements TaskStoreProvisioningClient
{
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    private readonly adminToken: string,
    opts?: { fetchFn?: typeof fetch },
  ) {
    this.fetchFn = opts?.fetchFn ?? fetch;
  }

  async mintToken(
    label: string,
    agentId?: string,
  ): Promise<{ id: string; rawToken: string }> {
    const res = await this.fetchFn(`${this.baseUrl}/tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.adminToken}`,
      },
      body: JSON.stringify({ label, ...(agentId ? { agentId } : {}) }),
    });
    if (!res.ok) {
      throw new Error(
        `task-store POST /tokens failed: ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as { id: string; rawToken: string };
    return { id: body.id, rawToken: body.rawToken };
  }

  async revokeToken(id: string): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/tokens/${id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.adminToken}`,
      },
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(
        `task-store DELETE /tokens/${id} failed: ${res.status} ${res.statusText}`,
      );
    }
  }
}

// ─── No-op implementation ─────────────────────────────────────────────────────

/**
 * No-op client used when SHIPWRIGHT_TASK_STORE_URL / SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN
 * are not configured. mintToken returns empty strings so callers can gate on
 * the configured path without null-checking the return.
 */
export class NoopTaskStoreProvisioningClient
  implements TaskStoreProvisioningClient
{
  async mintToken(
    _label: string,
    _agentId?: string,
  ): Promise<{ id: string; rawToken: string }> {
    return { id: "", rawToken: "" };
  }

  async revokeToken(_id: string): Promise<void> {
    // intentionally a no-op
  }
}
