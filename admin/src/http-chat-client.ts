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

export interface MessageTokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: string;
  body: string;
  createdAt: string;
  claimedBy: string | null;
  claimed?: boolean;
  claimedAt?: string | null;
  heartbeatAt?: string | null;
  repliedAt: string | null;
  tokens: MessageTokens | null;
  costUsd: number | null;
  errorKind?: string | null;
  attachmentFilename: string | null;
  attachmentSize: number | null;
  /**
   * Live-progress columns (added chat-side in CFB-2.2). The agent's heartbeat
   * reports a coarse `progressPhase` (one of lib/progress-phases.ts's closed
   * set, or null before the first phase is reported) and bumps `progressSeq`
   * every time it makes forward progress. `cancelRequestedAt` is set when a
   * cancel has been requested for the in-flight reply. All optional so older
   * fixtures / responses that predate these columns deserialize cleanly.
   */
  progressPhase?: string | null;
  progressSeq?: number;
  cancelRequestedAt?: string | null;
}

export interface ThreadStats {
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
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
  /**
   * Return only messages ordered *after* the message with this id. Applied as
   * a read-side filter over the full ordered result (the chat service itself
   * only understands limit/offset), so incremental polls stay cheap without
   * changing the chat service HTTP API.
   */
  since?: string;
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

  getThreadStats(threadId: string): Promise<ThreadStats>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return only the messages ordered *after* the message whose id is `since`,
 * assuming `messages` is in chronological order. If `since` isn't found (e.g.
 * the client's last-seen id was trimmed away), returns the full list so the
 * caller re-syncs rather than silently dropping everything.
 */
export function filterSince(
  messages: ChatMessage[],
  since: string,
): ChatMessage[] {
  const idx = messages.findIndex((m) => m.id === since);
  return idx === -1 ? messages : messages.slice(idx + 1);
}

// ─── Http implementation ──────────────────────────────────────────────────────

export class HttpChatClient implements ChatClient {
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    private readonly adminToken: string,
    opts?: { fetchFn?: typeof fetch },
  ) {
    this.fetchFn = opts?.fetchFn ?? fetch;
  }

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
    const res = await this.fetchFn(`${this.baseUrl}/threads${qs}`, {
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
    const res = await this.fetchFn(`${this.baseUrl}/threads/${id}`, {
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
    const res = await this.fetchFn(`${this.baseUrl}/threads`, {
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

  async updateThread(
    id: string,
    data: UpdateThreadOptions,
  ): Promise<ChatThread> {
    const res = await this.fetchFn(`${this.baseUrl}/threads/${id}`, {
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
    const res = await this.fetchFn(`${this.baseUrl}/threads/${id}`, {
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
    const res = await this.fetchFn(
      `${this.baseUrl}/threads/${threadId}/messages${qs}`,
      {
        headers: this.authHeaders(),
      },
    );
    if (!res.ok) {
      throw new Error(
        `chat-service GET /threads/${threadId}/messages failed: ${res.status} ${res.statusText}`,
      );
    }
    const result = (await res.json()) as ListMessagesResult;
    if (opts?.since) {
      return { ...result, messages: filterSince(result.messages, opts.since) };
    }
    return result;
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
    const res = await this.fetchFn(
      `${this.baseUrl}/threads/${threadId}/messages`,
      {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      throw new Error(
        `chat-service POST /threads/${threadId}/messages failed: ${res.status} ${res.statusText}`,
      );
    }
    return res.json() as Promise<ChatMessage>;
  }

  async getThreadStats(threadId: string): Promise<ThreadStats> {
    const res = await this.fetchFn(
      `${this.baseUrl}/threads/${threadId}/stats`,
      {
        headers: this.authHeaders(),
      },
    );
    if (!res.ok) {
      throw new Error(
        `chat-service GET /threads/${threadId}/stats failed: ${res.status} ${res.statusText}`,
      );
    }
    return res.json() as Promise<ThreadStats>;
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

  async updateThread(
    _id: string,
    data: UpdateThreadOptions,
  ): Promise<ChatThread> {
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
      progressPhase: null,
      progressSeq: 0,
      cancelRequestedAt: null,
    };
  }

  async getThreadStats(_threadId: string): Promise<ThreadStats> {
    return {
      messageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
    };
  }
}
