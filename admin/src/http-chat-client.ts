/**
 * admin/src/http-chat-client.ts
 * Chat service client for the admin service.
 *
 * Mirrors the HttpChatServiceProvisioningClient pattern for consistency.
 * All methods call the chat service's thread + message API using an admin token.
 */

// ─── Types (inline — no cross-package coupling) ───────────────────────────────

export interface ChatThread {
  id: string;
  agentId: string;
  title: string | null;
  memberId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: string;
  body: string;
  createdAt: string;
  claimedBy: string | null;
  repliedAt: string | null;
  tokens: number | null;
  costUsd: number | null;
  errorKind?: string | null;
  attachmentFilename: string | null;
  attachmentSize: number | null;
}

/** Optional file attachment carried alongside a created message. */
export interface MessageAttachment {
  filename: string;
  size: number;
  bytes: Uint8Array;
}

export interface ListThreadsResult {
  threads: ChatThread[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListMessagesResult {
  messages: ChatMessage[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListThreadsOptions {
  limit?: number;
  offset?: number;
}

export interface ListMessagesOptions {
  limit?: number;
  offset?: number;
}

export interface CreateThreadOptions {
  title?: string;
  memberId?: string;
}

export interface UpdateThreadOptions {
  title?: string;
}

// ─── Interface ────────────────────────────────────────────────────────────────

export interface ChatClient {
  listThreads(
    agentId?: string,
    opts?: ListThreadsOptions,
  ): Promise<ListThreadsResult>;

  getThread(id: string): Promise<ChatThread>;

  createThread(
    agentId: string,
    opts?: CreateThreadOptions,
  ): Promise<ChatThread>;

  updateThread(id: string, data: UpdateThreadOptions): Promise<ChatThread>;

  deleteThread(id: string): Promise<void>;

  listMessages(
    threadId: string,
    opts?: ListMessagesOptions,
  ): Promise<ListMessagesResult>;

  createMessage(
    threadId: string,
    role: string,
    body: string,
    attachment?: MessageAttachment,
  ): Promise<ChatMessage>;
}

// ─── Http implementation ──────────────────────────────────────────────────────

export class HttpChatClient implements ChatClient {
  constructor(
    private readonly baseUrl: string,
    private readonly adminToken: string,
  ) {}

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.adminToken}`,
      "Content-Type": "application/json",
    };
  }

  async listThreads(
    agentId?: string,
    opts?: ListThreadsOptions,
  ): Promise<ListThreadsResult> {
    const params = new URLSearchParams();
    if (agentId) params.set("agentId", agentId);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.size > 0 ? `?${params}` : "";
    const res = await fetch(`${this.baseUrl}/threads${qs}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(
        `chat-service GET /threads failed: ${res.status} ${res.statusText}`,
      );
    }
    return res.json() as Promise<ListThreadsResult>;
  }

  async getThread(id: string): Promise<ChatThread> {
    const res = await fetch(`${this.baseUrl}/threads/${id}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(
        `chat-service GET /threads/${id} failed: ${res.status} ${res.statusText}`,
      );
    }
    return res.json() as Promise<ChatThread>;
  }

  async createThread(
    agentId: string,
    opts?: CreateThreadOptions,
  ): Promise<ChatThread> {
    const res = await fetch(`${this.baseUrl}/threads`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        agentId,
        ...(opts?.title ? { title: opts.title } : {}),
        ...(opts?.memberId ? { memberId: opts.memberId } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(
        `chat-service POST /threads failed: ${res.status} ${res.statusText}`,
      );
    }
    return res.json() as Promise<ChatThread>;
  }

  async updateThread(id: string, data: UpdateThreadOptions): Promise<ChatThread> {
    const res = await fetch(`${this.baseUrl}/threads/${id}`, {
      method: "PATCH",
      headers: this.authHeaders(),
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      throw new Error(
        `chat-service PATCH /threads/${id} failed: ${res.status} ${res.statusText}`,
      );
    }
    return res.json() as Promise<ChatThread>;
  }

  async deleteThread(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/threads/${id}`, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(
        `chat-service DELETE /threads/${id} failed: ${res.status} ${res.statusText}`,
      );
    }
  }

  async listMessages(
    threadId: string,
    opts?: ListMessagesOptions,
  ): Promise<ListMessagesResult> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.size > 0 ? `?${params}` : "";
    const res = await fetch(`${this.baseUrl}/threads/${threadId}/messages${qs}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(
        `chat-service GET /threads/${threadId}/messages failed: ${res.status} ${res.statusText}`,
      );
    }
    return res.json() as Promise<ListMessagesResult>;
  }

  async createMessage(
    threadId: string,
    role: string,
    body: string,
    attachment?: MessageAttachment,
  ): Promise<ChatMessage> {
    const payload: Record<string, unknown> = { role, body };
    if (attachment) {
      payload.attachmentBytes = Buffer.from(attachment.bytes).toString(
        "base64",
      );
      payload.attachmentFilename = attachment.filename;
      payload.attachmentSize = attachment.size;
    }
    const res = await fetch(`${this.baseUrl}/threads/${threadId}/messages`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(
        `chat-service POST /threads/${threadId}/messages failed: ${res.status} ${res.statusText}`,
      );
    }
    return res.json() as Promise<ChatMessage>;
  }
}

// ─── Noop implementation ──────────────────────────────────────────────────────

export class NoopChatClient implements ChatClient {
  async listThreads(
    _agentId?: string,
    _opts?: ListThreadsOptions,
  ): Promise<ListThreadsResult> {
    return { threads: [], total: 0, limit: 50, offset: 0 };
  }

  async getThread(_id: string): Promise<ChatThread> {
    return {
      id: "",
      agentId: "",
      title: null,
      memberId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async createThread(
    _agentId: string,
    _opts?: CreateThreadOptions,
  ): Promise<ChatThread> {
    return {
      id: "",
      agentId: _agentId,
      title: null,
      memberId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async updateThread(_id: string, data: UpdateThreadOptions): Promise<ChatThread> {
    return {
      id: _id,
      agentId: "",
      title: data.title ?? null,
      memberId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async deleteThread(_id: string): Promise<void> {
    // noop
  }

  async listMessages(
    _threadId: string,
    _opts?: ListMessagesOptions,
  ): Promise<ListMessagesResult> {
    return { messages: [], total: 0, limit: 50, offset: 0 };
  }

  async createMessage(
    threadId: string,
    role: string,
    body: string,
    attachment?: MessageAttachment,
  ): Promise<ChatMessage> {
    return {
      id: "",
      threadId,
      role,
      body,
      createdAt: new Date().toISOString(),
      claimedBy: null,
      repliedAt: null,
      tokens: null,
      costUsd: null,
      errorKind: null,
      attachmentFilename: attachment?.filename ?? null,
      attachmentSize: attachment?.size ?? null,
    };
  }
}
