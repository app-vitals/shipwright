/**
 * agent/src/slack-socket-mode-ping.integration.test.ts
 *
 * Regression coverage for the fleet-wide Slack reconnect-loop incident that
 * followed the @slack/bolt 4.7.3 -> 5.0.0 bump (SSB-1.1, #3006): Bolt 5's
 * bundled @slack/socket-mode@3.x builds its whole ping/pong heartbeat
 * (SlackWebSocket's monitorPingToSlack / monitorPingFromSlack) on the real
 * `undici` package's module-level `ping()` helper and its
 * `undici:websocket:ping` / `undici:websocket:pong` diagnostics_channel
 * events. Bun always intercepts the bare "undici" specifier with its own
 * built-in polyfill — even though the real package is installed right
 * alongside it — and that polyfill implements neither API
 * (oven-sh/bun#37110, root-caused and reproduced by Bun's own team; fix in
 * progress at PR #37111, unmerged as of this writing). Under Bun, every
 * client-side ping tick threw `undici_1.ping is not a function` and
 * immediately disconnected — a continuous ~5-7s reconnect loop across the
 * whole agent fleet, not an intermittent Slack-side issue.
 *
 * patches/@slack%2Fsocket-mode@3.0.1.patch (see package.json
 * `patchedDependencies`) fixes this by requiring `undici/index.js` (a
 * subpath, which Bun's specifier interception does not match) instead of
 * bare `"undici"` — resolving the real, complete undici package that
 * already satisfies this file's own `peerDependencies: { undici: "^7.0.0"
 * }` and sits right there as a sibling in its own resolved node_modules.
 *
 * No existing suite would catch a regression here:
 *   - slack.integration.test.ts / slack-bolt-client.integration.test.ts
 *     construct a real @slack/bolt App but never open a live socket-mode
 *     connection, so they never reach SlackWebSocket's ping/pong cycle.
 *   - A unit test mocking the websocket/undici surface would pass
 *     regardless of which `undici` Bun actually resolves at runtime — the
 *     whole failure mode is specific to Bun's real, unmocked module
 *     resolution.
 *
 * This test opens a REAL local WebSocket server and drives @slack/bolt's
 * actual bundled @slack/socket-mode's SlackWebSocket against it — resolved
 * via require.resolve anchored at @slack/bolt's own location, so it
 * exercises the exact same file and dependency resolution Bolt uses in
 * production — asserting both ping directions succeed and the connection
 * survives multiple ping/pong cycles without disconnecting.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { WebSocketServer } from "ws";

type SlackWebSocketCtor = new (options: {
  url: string;
  client: EventEmitter;
  logger: {
    getLevel: () => string;
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  pingInterval?: number;
  clientPingTimeoutMS?: number;
  serverPingTimeoutMS?: number;
}) => {
  connect: () => Promise<void>;
  disconnect: () => void;
};

function resolveSlackWebSocket(): SlackWebSocketCtor {
  const boltEntry = require.resolve("@slack/bolt");
  const swPath = require.resolve(
    "@slack/socket-mode/dist/src/SlackWebSocket.js",
    {
      paths: [boltEntry],
    },
  );
  // biome-ignore lint/suspicious/noExplicitAny: dynamic require of an internal dist file
  return (require(swPath) as any).SlackWebSocket;
}

describe("@slack/socket-mode SlackWebSocket — ping/pong heartbeat under Bun", () => {
  test("client ping, server ping, and pong detection all work without disconnecting", async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;

    let serverGotClientPing = false;
    let serverSentPing = false;
    server.on("connection", (ws) => {
      ws.on("ping", () => {
        serverGotClientPing = true;
      });
      // Simulate Slack's own server-initiated pings.
      const interval = setInterval(() => {
        serverSentPing = true;
        ws.ping(Buffer.from("srv"));
      }, 300);
      ws.on("close", () => clearInterval(interval));
    });

    const SlackWebSocket = resolveSlackWebSocket();
    const client = new EventEmitter();
    let disconnected = false;
    client.on("close", () => {
      disconnected = true;
    });

    const errors: string[] = [];
    const sw = new SlackWebSocket({
      url: `ws://localhost:${port}`,
      client,
      logger: {
        getLevel: () => "info",
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (m: unknown) => {
          errors.push(String(m));
        },
      },
      pingInterval: 300,
      clientPingTimeoutMS: 900,
      serverPingTimeoutMS: 1500,
    });

    try {
      await sw.connect();
      // Long enough to cross several ping intervals in both directions —
      // the original bug disconnected on the very first tick.
      await new Promise((r) => setTimeout(r, 2000));

      expect(errors).toEqual([]);
      expect(serverGotClientPing).toBe(true);
      expect(serverSentPing).toBe(true);
      expect(disconnected).toBe(false);
    } finally {
      sw.disconnect();
      server.close();
    }
  });
});
