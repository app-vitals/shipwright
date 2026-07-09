/**
 * admin/src/chat-service-provisioning-client.ts
 *
 * Thin interface + implementations for minting/revoking per-agent chat-service
 * tokens during agent provisioning, and for cleaning up chat-service state
 * (tokens + threads) when an agent is deleted.
 *
 * The interface is the DI boundary. Tests inject a stub; production wires in
 * HttpChatServiceProvisioningClient (or skips chat-service wiring entirely by
 * omitting the client from KubernetesAgentProvisionerConfig).
 */

// ─── Interface ───────────────────────────────────────────────────────────────

export interface ChatServiceProvisioningClient {
  mintToken(
    label: string,
    agentId?: string,
  ): Promise<{ id: string; rawToken: string }>;

  revokeToken(id: string): Promise<void>;

  /**
   * List the ids of every chat-service token scoped to `agentId`.
   *
   * chat-service's GET /tokens has no server-side agentId filter — it returns
   * every token in the store — so this fetches the full list and filters
   * client-side. Intended to be paired with `revokeToken` by the caller (e.g.
   * agent-deletion cleanup): list, then revoke each match.
   */
  listTokensForAgent(agentId: string): Promise<{ id: string }[]>;

  /**
   * Delete every chat Thread scoped to `agentId`. Deleting a thread cascades
   * its Message rows at the DB level, so no separate message cleanup is
   * needed. Tolerates an individual thread already being gone (404) so this
   * is safe to re-run (idempotent retry).
   *
   * Returns the number of threads *attempted* to delete — a tolerated 404
   * still counts, since a re-run over an already-partially-cleaned agent
   * should report those threads as handled rather than looking like it did
   * nothing.
   */
  deleteThreadsForAgent(agentId: string): Promise<{ deleted: number }>;
}

// ─── HTTP implementation ──────────────────────────────────────────────────────

/**
 * Real HTTP client for the chat-service token + thread APIs.
 *
 * POST   /tokens        → { id, rawToken, ... }
 * GET    /tokens         (no server-side agentId filter — filtered client-side)
 * DELETE /tokens/:id
 * GET    /threads?agentId=  (server-side agentId filter; paginated via offset)
 * DELETE /threads/:id
 *
 * The admin token is passed via Bearer auth and is never stored in the Secret
 * or handed to the agent — only the per-agent rawToken is.
 */
export class HttpChatServiceProvisioningClient
  implements ChatServiceProvisioningClient
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
        `chat-service POST /tokens failed: ${res.status} ${res.statusText}`,
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
        `chat-service DELETE /tokens/${id} failed: ${res.status} ${res.statusText}`,
      );
    }
  }

  async listTokensForAgent(agentId: string): Promise<{ id: string }[]> {
    const res = await this.fetchFn(`${this.baseUrl}/tokens`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.adminToken}`,
      },
    });
    if (!res.ok) {
      throw new Error(
        `chat-service GET /tokens failed: ${res.status} ${res.statusText}`,
      );
    }
    const tokens = (await res.json()) as {
      id: string;
      agentId?: string | null;
    }[];
    return tokens
      .filter((token) => token.agentId === agentId)
      .map((token) => ({ id: token.id }));
  }

  async deleteThreadsForAgent(agentId: string): Promise<{ deleted: number }> {
    const threadIds = await this.listThreadIdsForAgent(agentId);

    let deleted = 0;
    for (const threadId of threadIds) {
      const res = await this.fetchFn(`${this.baseUrl}/threads/${threadId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this.adminToken}`,
        },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(
          `chat-service DELETE /threads/${threadId} failed: ${res.status} ${res.statusText}`,
        );
      }
      // A tolerated 404 still counts as attempted/completed — see the
      // interface doc comment on deleteThreadsForAgent.
      deleted++;
    }
    return { deleted };
  }

  /**
   * Fetch every thread id scoped to `agentId`, looping on `offset` while the
   * response's `total` exceeds what's been collected so far. Orphan cleanup
   * must not silently leave rows behind, so (unlike listTokensForAgent, which
   * chat-service returns in one unfiltered page) this follows pagination
   * rather than assuming a single page covers every thread.
   */
  private async listThreadIdsForAgent(agentId: string): Promise<string[]> {
    const ids: string[] = [];
    let offset = 0;

    for (;;) {
      const res = await this.fetchFn(
        `${this.baseUrl}/threads?agentId=${encodeURIComponent(agentId)}&offset=${offset}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.adminToken}`,
          },
        },
      );
      if (!res.ok) {
        throw new Error(
          `chat-service GET /threads failed: ${res.status} ${res.statusText}`,
        );
      }
      const body = (await res.json()) as {
        threads: { id: string }[];
        total: number;
      };
      for (const thread of body.threads) ids.push(thread.id);
      offset += body.threads.length;

      if (body.threads.length === 0 || offset >= body.total) break;
    }

    return ids;
  }
}

// ─── No-op implementation ─────────────────────────────────────────────────────

export class NoopChatServiceProvisioningClient
  implements ChatServiceProvisioningClient
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

  async listTokensForAgent(_agentId: string): Promise<{ id: string }[]> {
    return [];
  }

  async deleteThreadsForAgent(_agentId: string): Promise<{ deleted: number }> {
    return { deleted: 0 };
  }
}
