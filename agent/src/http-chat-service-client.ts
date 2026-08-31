/**
 * agent/src/http-chat-service-client.ts
 *
 * Typed HTTP client for the Shipwright chat service REST API.
 *
 * - ChatServiceClientError — typed error with statusCode
 * - ChatServiceClient — interface for DI / testability
 * - HttpChatServiceClient — production implementation with injectable fetchFn
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Thread {
  id: string;
  agentId: string;
  memberId: string | null;
  title: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface Message {
  id: string;
  threadId: string;
  role: string;
  body: string;
  claimedBy: string | null;
  claimedAt: Date | string | null;
  heartbeatAt: Date | string | null;
  cancelRequestedAt: Date | string | null;
  repliedAt: Date | string | null;
  tokens: unknown;
  costUsd: number | null;
  attachmentFilename: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/**
 * Result of a heartbeat tick. The tick is bidirectional: the same request that
 * proves liveness returns whether a cancel was requested, so there is no second
 * polling loop and no inbound HTTP surface on the agent.
 */
export interface HeartbeatResult {
  /** True when cancelRequestedAt is set on the message — the run should abort. */
  cancelRequested: boolean;
}

export interface ReplyResult {
  userMessage: Message;
  assistantMessage: Message;
}

export interface ListThreadsOptions {
  agentId?: string;
  limit?: number;
  offset?: number;
}

export interface ListThreadsResult {
  threads: Thread[];
  total: number;
  limit: number;
  offset: number;
}

export interface ReplyOptions {
  body: string;
  tokens?: unknown;
  costUsd?: number;
  /** Stamped on the assistant message so the UI can offer a Retry action. */
  errorKind?: string;
}

// ─── Error ────────────────────────────────────────────────────────────────────

export class ChatServiceClientError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatServiceClientError";
  }
}

// ─── Interface ────────────────────────────────────────────────────────────────

export interface ChatServiceClient {
  listThreads(opts: ListThreadsOptions): Promise<ListThreadsResult>;
  /** Returns null when there are no unclaimed messages in the thread. */
  claimMessage(threadId: string): Promise<Message | null>;
  /**
   * Bump a claimed message's heartbeatAt — proof of life while a long-running
   * reply is in progress — and learn whether a cancel was requested. The tick
   * is bidirectional (see HeartbeatResult): the returned message carries
   * cancelRequestedAt, from which cancelRequested is derived. Best-effort:
   * callers should swallow failures rather than let a heartbeat blip abort the
   * reply itself.
   */
  heartbeat(threadId: string, messageId: string): Promise<HeartbeatResult>;
  replyToMessage(
    threadId: string,
    messageId: string,
    opts: ReplyOptions,
  ): Promise<ReplyResult>;
  /**
   * Fetch a message's attachment bytes. Returns null when there is no
   * attachment (404). The chat service drops the bytes after serving them.
   */
  getAttachment(
    threadId: string,
    messageId: string,
  ): Promise<Uint8Array | null>;
}

// ─── HttpChatServiceClient ────────────────────────────────────────────────────

type FetchFn = (
  url: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class HttpChatServiceClient implements ChatServiceClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: FetchFn;

  constructor(opts: {
    baseUrl: string;
    token: string;
    /** Injectable fetch for testing. Defaults to global fetch. */
    fetchFn?: FetchFn;
  }) {
    // Strip trailing slash for clean URL construction
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  async listThreads(opts: ListThreadsOptions): Promise<ListThreadsResult> {
    const url = new URL(`${this.baseUrl}/threads`);
    if (opts.agentId !== undefined)
      url.searchParams.set("agentId", opts.agentId);
    if (opts.limit !== undefined)
      url.searchParams.set("limit", String(opts.limit));
    if (opts.offset !== undefined)
      url.searchParams.set("offset", String(opts.offset));

    const res = await this.fetchFn(url.toString(), {
      method: "GET",
      headers: this.authHeaders(),
    });

    if (!res.ok) {
      throw new ChatServiceClientError(
        res.status,
        `GET /threads failed: ${res.status}`,
      );
    }

    return res.json() as Promise<ListThreadsResult>;
  }

  async claimMessage(threadId: string): Promise<Message | null> {
    const url = `${this.baseUrl}/threads/${threadId}/messages/claim`;

    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.authHeaders(),
    });

    // 404 = no unclaimed messages — not an error, just means nothing to do
    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      throw new ChatServiceClientError(
        res.status,
        `POST /threads/${threadId}/messages/claim failed: ${res.status}`,
      );
    }

    return res.json() as Promise<Message>;
  }

  async heartbeat(
    threadId: string,
    messageId: string,
  ): Promise<HeartbeatResult> {
    const url = `${this.baseUrl}/threads/${threadId}/messages/${messageId}/heartbeat`;

    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.authHeaders(),
    });

    if (!res.ok) {
      throw new ChatServiceClientError(
        res.status,
        `POST /threads/${threadId}/messages/${messageId}/heartbeat failed: ${res.status}`,
      );
    }

    const message = (await res.json()) as Message;
    return { cancelRequested: message.cancelRequestedAt != null };
  }

  async replyToMessage(
    threadId: string,
    messageId: string,
    opts: ReplyOptions,
  ): Promise<ReplyResult> {
    const url = `${this.baseUrl}/threads/${threadId}/messages/${messageId}/reply`;

    const body: Record<string, unknown> = { body: opts.body };
    if (opts.tokens !== undefined) body.tokens = opts.tokens;
    if (opts.costUsd !== undefined) body.costUsd = opts.costUsd;
    if (opts.errorKind !== undefined) body.errorKind = opts.errorKind;

    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new ChatServiceClientError(
        res.status,
        `POST /threads/${threadId}/messages/${messageId}/reply failed: ${res.status}`,
      );
    }

    return res.json() as Promise<ReplyResult>;
  }

  async getAttachment(
    threadId: string,
    messageId: string,
  ): Promise<Uint8Array | null> {
    const url = `${this.baseUrl}/threads/${threadId}/messages/${messageId}/attachment`;

    const res = await this.fetchFn(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.token}` },
    });

    // 404 = no attachment — not an error, nothing to pull.
    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      throw new ChatServiceClientError(
        res.status,
        `GET /threads/${threadId}/messages/${messageId}/attachment failed: ${res.status}`,
      );
    }

    return new Uint8Array(await res.arrayBuffer());
  }
}
