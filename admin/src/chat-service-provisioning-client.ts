export interface ChatServiceProvisioningClient {
  mintToken(
    label: string,
    agentId?: string,
  ): Promise<{ id: string; rawToken: string }>;

  revokeToken(id: string): Promise<void>;
}

export class HttpChatServiceProvisioningClient
  implements ChatServiceProvisioningClient
{
  constructor(
    private readonly baseUrl: string,
    private readonly adminToken: string,
  ) {}

  async mintToken(
    label: string,
    agentId?: string,
  ): Promise<{ id: string; rawToken: string }> {
    const res = await fetch(`${this.baseUrl}/tokens`, {
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
    const res = await fetch(`${this.baseUrl}/tokens/${id}`, {
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
}

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
}
