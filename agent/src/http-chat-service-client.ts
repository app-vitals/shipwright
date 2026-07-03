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
  repliedAt: Date | string | null;
  tokens: unknown;
  costUsd: number | null;
  attachmentFilename: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
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
    if (opts.agentId !== undefined) url.searchParams.set("agentId", opts.agentId);
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

  async replyToMessage(
    threadId: string,
    messageId: string,
    opts: ReplyOptions,
  ): Promise<ReplyResult> {
    const url = `${this.baseUrl}/threads/${threadId}/messages/${messageId}/reply`;

    const body: Record<string, unknown> = { body: opts.body };
    if (opts.tokens !== undefined) body.tokens = opts.tokens;
    if (opts.costUsd !== undefined) body.costUsd = opts.costUsd;

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
