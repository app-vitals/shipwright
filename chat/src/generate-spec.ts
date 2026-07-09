/**
 * chat/src/generate-spec.ts
 * Core logic for generating the OpenAPI 3.1 spec for the chat service.
 *
 * Exported as a pure function so it can be called from:
 *   - scripts/generate-chat-spec.ts (the CLI entry point)
 *   - chat/src/generate-spec.unit.test.ts (for automated verification)
 *
 * Instantiates the tokens, threads, and messages sub-apps with minimal stubs
 * (no real DB, no real services), calls getOpenAPI31Document() on each, and
 * merges the results into a single OpenAPI 3.1 document.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MessageServiceLike } from "./message-service.ts";
import { createMessagesRoutes } from "./routes/messages.ts";
import { createThreadsRoutes } from "./routes/threads.ts";
import { createTokensRoutes } from "./routes/tokens.ts";
import type { ThreadServiceLike } from "./thread-service.ts";
import type { ChatTokenServiceLike } from "./token-service.ts";

// ─── Stub deps — only route definitions matter for spec generation ────────────

const stubChatTokenService: ChatTokenServiceLike = {
  async create() {
    return { token: {} as never, rawToken: "" };
  },
  async validate() {
    return null;
  },
  async revoke() {
    return null;
  },
  async list() {
    return [];
  },
  async update() {
    return null;
  },
  async seed() {},
};

const stubThreadService: ThreadServiceLike = {
  async create() {
    return {} as never;
  },
  async findById() {
    return null;
  },
  async list() {
    return { threads: [], total: 0 };
  },
  async update() {
    return null;
  },
  async delete() {
    return null;
  },
  async getStats() {
    return {
      messageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
    };
  },
};

const stubMessageService: MessageServiceLike = {
  async create() {
    return {} as never;
  },
  async findById() {
    return null;
  },
  async list() {
    return { messages: [], total: 0 };
  },
  async update() {
    return null;
  },
  async delete() {
    return null;
  },
  async clearAttachmentBytes() {
    return null;
  },
  async claim() {
    return null;
  },
  async reply() {
    return null;
  },
};

// ─── Spec assembly ────────────────────────────────────────────────────────────

function prefixPaths(
  paths: Record<string, Record<string, unknown>>,
  prefix: string,
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const [path, def] of Object.entries(paths)) {
    const prefixed = (path === "/" ? prefix : `${prefix}${path}`).replace(
      /:([\w]+)/g,
      "{$1}",
    );
    result[prefixed] = def as Record<string, unknown>;
  }
  return result;
}

/** Build the OpenAPI 3.1 spec document in memory. */
export function buildChatSpec(): Record<string, unknown> {
  const tokensApp = createTokensRoutes(stubChatTokenService);
  const threadsApp = createThreadsRoutes(stubThreadService);
  const messagesApp = createMessagesRoutes(
    stubThreadService,
    stubMessageService,
  );

  const innerDocInfo = {
    openapi: "3.1.0" as const,
    info: { title: "internal", version: "0.1.0" },
  } as const;

  const tokensSpec = tokensApp.getOpenAPI31Document(innerDocInfo);
  const threadsSpec = threadsApp.getOpenAPI31Document(innerDocInfo);
  const messagesSpec = messagesApp.getOpenAPI31Document(innerDocInfo);

  const mergedPaths: Record<string, Record<string, unknown>> = {
    ...prefixPaths(
      (tokensSpec.paths ?? {}) as Record<string, Record<string, unknown>>,
      "/tokens",
    ),
    ...prefixPaths(
      (threadsSpec.paths ?? {}) as Record<string, Record<string, unknown>>,
      "/threads",
    ),
    ...prefixPaths(
      (messagesSpec.paths ?? {}) as Record<string, Record<string, unknown>>,
      "/threads/:threadId/messages",
    ),
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Shipwright Chat API",
      version: "0.1.0",
      description:
        "REST API for the Shipwright chat service — threads, messages, attachments, and scoped token administration.",
    },
    servers: [{ url: "http://localhost:3003", description: "Local dev" }],
    paths: mergedPaths,
    components: {
      schemas: {
        ...(tokensSpec.components?.schemas ?? {}),
        ...(threadsSpec.components?.schemas ?? {}),
        ...(messagesSpec.components?.schemas ?? {}),
      },
    },
  };
}

/** Write the spec to chat/openapi.json. */
export function generateChatSpec(outPath?: string): void {
  const spec = buildChatSpec();
  const resolvedOutPath =
    outPath ?? resolve(import.meta.dir, "../openapi.json");
  writeFileSync(resolvedOutPath, `${JSON.stringify(spec, null, 2)}\n`);
  console.log(`Written to ${resolvedOutPath}`);
}
