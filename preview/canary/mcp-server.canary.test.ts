import { afterAll, describe, expect, it } from "bun:test";
import {
  bearer,
  createTask,
  deleteTask,
  loadTargets,
  parseMcpBody,
} from "./client.ts";

const t = loadTargets();
const created: string[] = [];
const sessions: string[] = [];

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

type JsonRpc = {
  result?: { content?: { type: string; text: string }[]; isError?: boolean };
  error?: { message: string };
};

async function rpc(
  method: string,
  params: unknown,
  sessionId?: string,
): Promise<{ res: Response; body: JsonRpc }> {
  const res = await fetch(`${t.mcpUrl}/mcp`, {
    method: "POST",
    headers: {
      ...MCP_HEADERS,
      ...bearer(t.mcpToken),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  return {
    res,
    body: parseMcpBody(res.headers.get("content-type") ?? "", text) as JsonRpc,
  };
}

async function openSession(): Promise<string> {
  const { res } = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "preview-canary", version: "0.0.0" },
  });
  expect(res.status).toBe(200);
  const sessionId = res.headers.get("mcp-session-id") as string;
  expect(sessionId).toBeTruthy();
  sessions.push(sessionId);
  return sessionId;
}

afterAll(async () => {
  for (const id of created) await deleteTask(t, id);
  for (const sessionId of sessions) {
    await fetch(`${t.mcpUrl}/mcp`, {
      method: "DELETE",
      headers: { ...bearer(t.mcpToken), "mcp-session-id": sessionId },
    }).catch(() => undefined);
  }
});

describe("mcp-server canary", () => {
  it("lists the task created in the task-store, with the token", async () => {
    const task = await createTask(t);
    created.push(task.id);

    const sessionId = await openSession();
    const { res, body } = await rpc(
      "tools/call",
      { name: "tasks_list", arguments: { session: task.session } },
      sessionId,
    );
    expect(res.status).toBe(200);
    expect(body.result?.isError).not.toBe(true);
    const text = body.result?.content?.map((c) => c.text).join("") ?? "";
    expect(text).toContain(task.id);
    expect(text).toContain(task.title);
  });

  it("rejects a request without the token", async () => {
    const res = await fetch(`${t.mcpUrl}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "preview-canary", version: "0.0.0" },
        },
      }),
    });
    expect(res.status).toBe(401);
  });
});
