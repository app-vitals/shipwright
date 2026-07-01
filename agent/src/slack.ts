/**
 * Slack Bolt event handlers for the Shipwright agent.
 *
 * All dependencies are injected — no global config reads, no hardcoded
 * runClaude import. Call createSlackApp() with the runner returned by
 * createRunClaude() and your injected config values.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "@slack/bolt";
import type { WebAPIPlatformError } from "@slack/web-api";
import type { AnalyticsEvent } from "./analytics.ts";
import {
  type ChatTokenReporter,
  NoopChatTokenReporter,
} from "./chat-token-reporter.ts";
import { ClaudeRunError, ClaudeTimeoutError } from "./claude.ts";
import type { TokenUsage } from "./claude.ts";
import { formatPlanLink, markdownToBlocks, markdownToSlack } from "./format.ts";
import { type Marker, parseMarkers } from "./markers.ts";
import { threadKey as defaultThreadKey } from "./sessions.ts";
import type { VoiceConfig } from "./voice.ts";
import { synthesizeSpeech, transcribeAudio } from "./voice.ts";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

function isInvalidBlocksError(err: unknown): boolean {
  const e = err as Partial<WebAPIPlatformError>;
  return (
    e.code === "slack_webapi_platform_error" &&
    e.data?.error === "invalid_blocks"
  );
}

export interface SlackFile {
  name: string;
  mimetype: string;
  size: number;
  url_private?: string;
}

export async function downloadFile(
  file: SlackFile,
  botToken: string,
): Promise<string | null> {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    console.warn(
      `[slack] skipping ${file.name} (${file.size} bytes) — exceeds 10MB limit`,
    );
    return null;
  }
  const url = file.url_private;
  if (!url) return null;

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
  } catch (err) {
    console.warn(`[slack] file fetch error for ${file.name}:`, err);
    return null;
  }

  if (!resp.ok) {
    console.warn(
      `[slack] file download failed for ${file.name}: ${resp.status}`,
    );
    return null;
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  const tmpPath = join(tmpdir(), `shipwright-agent-${Date.now()}-${file.name}`);
  writeFileSync(tmpPath, buffer);
  return tmpPath;
}

interface SlackConfig {
  botToken: string;
  appToken: string;
  signingSecret: string;
}

/**
 * Whether the agent has the credentials required to start its Slack Bolt App.
 *
 * Bolt's Socket Mode constructor throws "Must provide an App-Level Token" when
 * `appToken` is empty, so the agent must skip Slack startup (offline mode)
 * unless BOTH the bot token and the app-level token are present. Whitespace-only
 * values are treated as absent.
 */
export function hasSlackCredentials(cfg: {
  botToken: string;
  appToken: string;
}): boolean {
  return cfg.botToken.trim() !== "" && cfg.appToken.trim() !== "";
}

type AppFactory = (cfg: {
  token: string;
  appToken: string;
  socketMode: true;
  signingSecret: string;
  // biome-ignore lint/suspicious/noExplicitAny: Bolt App type is complex
}) => any;

const defaultAppFactory: AppFactory = (cfg) =>
  new (require("@slack/bolt").App)(cfg);

export type Tracker = (event: Omit<AnalyticsEvent, "timestamp">) => void;
const noopTracker: Tracker = () => {};

type FileDownloaderFn = (
  file: SlackFile,
  botToken: string,
) => Promise<string | null>;

type ConversationsRepliesFn = (
  // biome-ignore lint/suspicious/noExplicitAny: Bolt client type is complex
  client: any,
  channel: string,
  ts: string,
) => Promise<{ messages?: { user?: string; text?: string; ts?: string }[] }>;

export type TranscribeAudioFn = typeof transcribeAudio;
export type SynthesizeSpeechFn = typeof synthesizeSpeech;
type GetSessionFn = (key: string) => string | undefined;

export type ClaudeRunner = (
  message: string,
  sessionKey?: string,
) => Promise<{
  result: string;
  sessionId?: string;
  usage?: TokenUsage;
  totalCostUsd?: number;
  modelUsage?: Record<string, TokenUsage>;
}>;

export type ResolveUserFn = (
  userId: string,
  // biome-ignore lint/suspicious/noExplicitAny: Bolt client is complex
  client: any,
) => Promise<string>;

export async function dispatchMarkers(
  markers: Marker[],
  {
    client,
    channel,
    postedTs,
    threadTs,
    workspace,
    synthesizeSpeechFn,
    voiceConfig = {},
  }: {
    // biome-ignore lint/suspicious/noExplicitAny: Bolt client type is complex
    client: any;
    channel: string;
    postedTs?: string;
    threadTs?: string;
    workspace?: string;
    synthesizeSpeechFn?: SynthesizeSpeechFn;
    voiceConfig?: VoiceConfig;
  },
): Promise<void> {
  for (const marker of markers) {
    if (marker.type === "silent") continue;

    if (marker.type === "react") {
      if (postedTs) {
        for (const emoji of marker.emojis) {
          await client.reactions
            .add({ channel, timestamp: postedTs, name: emoji })
            .catch((err: unknown) =>
              console.warn("[markers] react failed:", err),
            );
        }
      }
    } else if (marker.type === "upload") {
      const absPath = marker.path.startsWith("/")
        ? marker.path
        : workspace
          ? join(workspace, marker.path)
          : marker.path;
      if (existsSync(absPath)) {
        await client.files
          .uploadV2({
            channel_id: channel,
            thread_ts: threadTs,
            file: readFileSync(absPath),
            filename: absPath.split("/").pop() ?? "file",
          })
          .catch((err: unknown) =>
            console.warn("[markers] upload failed:", err),
          );
      } else {
        console.warn(`[markers] upload: file not found: ${absPath}`);
      }
    } else if (marker.type === "plan") {
      const { text, blocks } = formatPlanLink(marker.url);
      await client.chat
        .postMessage({ channel, thread_ts: threadTs, text, blocks })
        .catch((err: unknown) =>
          console.warn("[markers] plan link post failed:", err),
        );
    } else if (marker.type === "speak") {
      if (!synthesizeSpeechFn) {
        console.warn(
          "[markers] speak marker found but synthesizeSpeechFn not injected — skipping",
        );
        continue;
      }
      try {
        const audioPath = await synthesizeSpeechFn(marker.text, voiceConfig);
        if (audioPath) {
          await client.files
            .uploadV2({
              channel_id: channel,
              thread_ts: threadTs,
              file: readFileSync(audioPath),
              filename: audioPath.split("/").pop() ?? "response.mp3",
            })
            .catch((err: unknown) =>
              console.warn("[markers] speak upload failed:", err),
            );
        } else {
          console.warn(
            "[markers] speak synthesis returned null — no audio uploaded",
          );
        }
      } catch (err) {
        console.warn("[markers] speak synthesis failed:", err);
      }
    }
  }
}

function _classifyError(err: unknown): { lead: string; known: boolean } {
  if (err instanceof ClaudeTimeoutError) {
    return {
      lead: `:hourglass_flowing_sand: Session timed out after ${Math.round(err.timeoutMs / 60_000)} minutes. Please retry.`,
      known: true,
    };
  }
  if (err instanceof ClaudeRunError) {
    const status = err.apiErrorStatus;
    const detail = err.resultMessage;
    if (status === 429 && /usage limit/i.test(detail)) {
      return {
        lead: ":warning: I've hit the org's monthly Claude usage limit. Please try again later or contact the agent owner.",
        known: true,
      };
    }
    if (status === 429) {
      return {
        lead: ":warning: Rate-limited by Anthropic — try again in a moment.",
        known: true,
      };
    }
    if (status === 529) {
      return {
        lead: ":warning: Anthropic's API is overloaded. This is usually transient — try again in ~30s. Status: https://status.claude.com",
        known: true,
      };
    }
    if (status === 500 || status === 502 || status === 503 || status === 504) {
      return {
        lead: `:warning: Anthropic API hiccup (${status}). This is server-side and usually transient — please retry. Status: https://status.claude.com`,
        known: true,
      };
    }
    if (status === 401 || status === 403) {
      return {
        lead: `:warning: Auth failure with Anthropic (${status}). The agent's API key or OAuth token may need to be refreshed.`,
        known: true,
      };
    }
    return {
      lead: `:warning: Claude returned an error${status ? ` (${status})` : ""}.`,
      known: false,
    };
  }
  return { lead: ":warning: Something went wrong.", known: false };
}

function _detailLine(err: unknown): string {
  if (err instanceof ClaudeRunError) return err.resultMessage;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export function formatRunErrorForSlack(err: unknown): string {
  const { lead, known } = _classifyError(err);
  const detail = _detailLine(err);
  const stack =
    !known && err instanceof Error && err.stack ? err.stack : undefined;
  const stackBlock = stack ? `\n\n\`\`\`\n${stack}\n\`\`\`` : "";
  return `${lead}\n\n_Detail:_ ${detail}${stackBlock}`;
}

const defaultConversationsRepliesFn: ConversationsRepliesFn = async (
  client,
  channel,
  ts,
) => client.conversations.replies({ channel, ts, limit: 200 });

async function buildPromptWithFiles(
  text: string,
  files: SlackFile[] | undefined,
  fileDownloaderFn: FileDownloaderFn,
  botToken: string,
  transcribeAudioFn: TranscribeAudioFn,
  voiceConfig: VoiceConfig,
): Promise<string> {
  if (!files?.length) return text;
  const fileParts: string[] = [];
  for (const file of files) {
    try {
      const filePath = await fileDownloaderFn(file, botToken);
      if (filePath) {
        if (file.mimetype.startsWith("audio/")) {
          try {
            const transcript = await transcribeAudioFn(filePath, voiceConfig);
            fileParts.push(
              transcript
                ? `[voice transcript: ${transcript}]`
                : `[file: ${filePath}]`,
            );
          } catch (err) {
            console.warn("[voice] transcription error:", err);
            fileParts.push(`[file: ${filePath}]`);
          }
        } else {
          fileParts.push(`[file: ${filePath}]`);
        }
      }
    } catch (err) {
      console.warn(`[slack] file download error for ${file.name}:`, err);
    }
  }
  return fileParts.length ? `${fileParts.join("\n")}\n${text}`.trim() : text;
}

export function createSlackApp(
  runner: ClaudeRunner,
  formatter: (text: string) => string = markdownToSlack,
  getThreadKey: typeof defaultThreadKey = defaultThreadKey,
  appFactory: AppFactory = defaultAppFactory,
  slackConfig: SlackConfig = { botToken: "", appToken: "", signingSecret: "" },
  tracker: Tracker = noopTracker,
  fileDownloaderFn: FileDownloaderFn = downloadFile,
  voiceConfig: VoiceConfig = {},
  transcribeAudioFn: TranscribeAudioFn = transcribeAudio,
  synthesizeSpeechFn: SynthesizeSpeechFn = synthesizeSpeech,
  resolveUserFn: ResolveUserFn = async (userId) => userId,
  botUserId: string | undefined = undefined,
  conversationsRepliesFn: ConversationsRepliesFn = defaultConversationsRepliesFn,
  getSessionFn: GetSessionFn = () => undefined,
  blocksConverter: typeof markdownToBlocks = markdownToBlocks,
  chatTokenReporter: ChatTokenReporter = new NoopChatTokenReporter(),
): App {
  const app = appFactory({
    token: slackConfig.botToken,
    appToken: slackConfig.appToken,
    socketMode: true,
    signingSecret: slackConfig.signingSecret,
  });

  // DMs: respond to every message.
  // Channels: respond only if bot has already replied in this thread.
  // biome-ignore lint/suspicious/noExplicitAny: Bolt callback params
  app.message(async ({ message, say, client }: any) => {
    if (message.subtype && message.subtype !== "file_share") return;
    const msg = message as {
      text?: string;
      channel: string;
      ts: string;
      thread_ts?: string;
      channel_type?: string;
      files?: SlackFile[];
      user?: string;
    };

    const isDM = msg.channel_type === "im";
    const hasText = !!msg.text?.trim();
    const hasFiles = !!msg.files?.length;

    if (!hasText && !hasFiles) return;

    if (!isDM) {
      if (!msg.thread_ts) return;
      if (!getSessionFn(getThreadKey(msg.channel, msg.thread_ts))) return;
    }

    const sessionKey = getThreadKey(msg.channel, msg.thread_ts ?? msg.ts);
    const replyTs = msg.thread_ts ?? msg.ts;

    const setStatus = async (status: string) => {
      // biome-ignore lint/suspicious/noExplicitAny: Bolt types don't include Agents API yet
      await (client.assistant.threads as any)
        .setStatus({ channel_id: msg.channel, thread_ts: replyTs, status })
        .catch(() => {});
    };
    await setStatus("Thinking...");

    let prompt = await buildPromptWithFiles(
      msg.text ?? "",
      msg.files,
      fileDownloaderFn,
      slackConfig.botToken,
      transcribeAudioFn,
      voiceConfig,
    );

    if (msg.user) {
      const name = await resolveUserFn(msg.user, client);
      prompt = `[${name}]: ${prompt}`;
    }

    if (!isDM && msg.thread_ts) {
      prompt = `[Thread message — respond normally, or use [silent] if no response is needed]\n${prompt}`;
    }

    const startedAt = new Date();
    try {
      const { result, usage, totalCostUsd } = await runner(prompt, sessionKey);
      const endedAt = new Date();
      await chatTokenReporter.recordSession(usage, totalCostUsd);
      const { cleaned, markers } = parseMarkers(result);

      const isSilent = markers.some((m) => m.type === "silent");
      const dmOverride = isSilent && isDM && cleaned.trim().length > 0;
      const shouldSuppress = isSilent && !dmOverride;

      if (dmOverride) {
        console.log("[slack] ignoring [silent] marker in DM — posting reply");
      }
      if (shouldSuppress) {
        console.log(
          `[slack] silent response — not posting (cleaned: ${cleaned.length} chars)`,
        );
      }

      let postedTs: string | undefined;
      if (!shouldSuppress && cleaned.trim().length > 0) {
        const blocks = blocksConverter(cleaned);
        let sayResult: unknown;
        if (blocks) {
          try {
            sayResult = await say({
              text: blocks.text,
              blocks: blocks.blocks,
              thread_ts: msg.thread_ts ?? msg.ts,
            });
          } catch (err: unknown) {
            if (!isInvalidBlocksError(err)) throw err;
            console.warn("[slack] invalid_blocks — retrying with plain text");
            sayResult = await say({
              text: blocks.text || formatter(cleaned),
              thread_ts: msg.thread_ts ?? msg.ts,
            });
          }
        } else {
          sayResult = await say({
            text: formatter(cleaned),
            thread_ts: msg.thread_ts ?? msg.ts,
          });
        }
        postedTs = (sayResult as { ts?: string } | undefined)?.ts;
      } else if (!shouldSuppress) {
        console.log("[slack] markers-only response — skipping text post");
      }

      await dispatchMarkers(markers, {
        client,
        channel: msg.channel,
        postedTs,
        threadTs: msg.thread_ts ?? msg.ts,
        synthesizeSpeechFn,
        voiceConfig,
      });
      tracker({
        type: "message",
        sessionKey,
        durationMs: endedAt.getTime() - startedAt.getTime(),
      });
    } catch (err) {
      console.error("[slack] error:", err);
      tracker({
        type: "error",
        sessionKey,
        durationMs: Date.now() - startedAt.getTime(),
        error: err instanceof Error ? err.message : String(err),
      });
      await say({
        text: formatRunErrorForSlack(err),
        thread_ts: msg.thread_ts ?? msg.ts,
      });
    } finally {
      await setStatus("");
    }
  });

  // biome-ignore lint/suspicious/noExplicitAny: Bolt callback params
  app.event("app_mention", async ({ event, say, client }: any) => {
    const ev = event as {
      text: string;
      channel: string;
      ts: string;
      thread_ts?: string;
      user?: string;
      files?: SlackFile[];
    };
    const sessionKey = getThreadKey(ev.channel, ev.thread_ts ?? ev.ts);
    const replyTs = ev.thread_ts ?? ev.ts;

    // Drop @mention if bot is already participating in this thread —
    // the message handler covers it and would double-respond otherwise.
    if (ev.thread_ts && getSessionFn(sessionKey)) {
      return;
    }

    const setStatus = async (status: string) => {
      // biome-ignore lint/suspicious/noExplicitAny: Bolt types don't include Agents API yet
      await (client.assistant.threads as any)
        .setStatus({ channel_id: ev.channel, thread_ts: replyTs, status })
        .catch(() => {});
    };
    await setStatus("Thinking...");

    let prompt = await buildPromptWithFiles(
      ev.text,
      ev.files,
      fileDownloaderFn,
      slackConfig.botToken,
      transcribeAudioFn,
      voiceConfig,
    );

    if (ev.user) {
      const name = await resolveUserFn(ev.user as string, client);
      prompt = `[${name}]: ${prompt}`;
    }

    if (event.thread_ts && !getSessionFn(sessionKey)) {
      try {
        const repliesResult = await conversationsRepliesFn(
          client,
          event.channel as string,
          event.thread_ts as string,
        );
        const messages = repliesResult.messages ?? [];
        const historyLines = await Promise.all(
          messages
            .filter(
              (m) =>
                m.text &&
                m.text.trim() !== "" &&
                m.user &&
                (!botUserId || m.user !== botUserId) &&
                m.ts !== (event.ts as string),
            )
            .map(async (m) => {
              const name = await resolveUserFn(m.user as string, client);
              return `[${name}]: ${m.text}`;
            }),
        );
        if (historyLines.length > 0) {
          prompt = `[Thread context]\n${historyLines.join("\n")}\n[end thread context]\n\n${prompt}`;
        }
      } catch (err) {
        console.warn("[slack] failed to fetch thread history:", err);
      }
    }

    const startedAt = new Date();
    try {
      const { result, usage, totalCostUsd } = await runner(prompt, sessionKey);
      const endedAt = new Date();
      await chatTokenReporter.recordSession(usage, totalCostUsd);
      const { cleaned, markers } = parseMarkers(result);

      const isSilent = markers.some((m) => m.type === "silent");
      if (isSilent) {
        console.log(
          `[slack] silent response — not posting (channel mention, cleaned: ${cleaned.length} chars)`,
        );
      }

      let postedMentionTs: string | undefined;
      if (!isSilent && cleaned.trim().length > 0) {
        const blocks = blocksConverter(cleaned);
        let sayResult: unknown;
        if (blocks) {
          try {
            sayResult = await say({
              text: blocks.text,
              blocks: blocks.blocks,
              thread_ts: replyTs,
            });
          } catch (err: unknown) {
            if (!isInvalidBlocksError(err)) throw err;
            console.warn("[slack] invalid_blocks — retrying with plain text");
            sayResult = await say({
              text: blocks.text || formatter(cleaned),
              thread_ts: replyTs,
            });
          }
        } else {
          sayResult = await say({
            text: formatter(cleaned),
            thread_ts: replyTs,
          });
        }
        postedMentionTs = (sayResult as { ts?: string } | undefined)?.ts;
      } else if (!isSilent) {
        console.log("[slack] markers-only response — skipping text post");
      }

      await dispatchMarkers(markers, {
        client,
        channel: ev.channel,
        postedTs: postedMentionTs,
        threadTs: replyTs,
        synthesizeSpeechFn,
        voiceConfig,
      });
      tracker({
        type: "mention",
        sessionKey,
        durationMs: endedAt.getTime() - startedAt.getTime(),
      });
    } catch (err) {
      console.error("[slack] error:", err);
      tracker({
        type: "error",
        sessionKey,
        durationMs: Date.now() - startedAt.getTime(),
        error: err instanceof Error ? err.message : String(err),
      });
      await say({ text: formatRunErrorForSlack(err), thread_ts: replyTs });
    } finally {
      await setStatus("");
    }
  });

  // biome-ignore lint/suspicious/noExplicitAny: Bolt callback params
  app.event("reaction_added", async ({ event, client }: any) => {
    const ev = event as {
      reaction: string;
      item: { type: string; channel: string; ts: string };
      item_user: string;
      user: string;
    };

    if (ev.item.type !== "message") return;
    if (!botUserId || ev.item_user !== botUserId) return;
    if (!ev.item.channel.startsWith("D")) return;

    const sessionKey = getThreadKey(ev.item.channel, ev.item.ts);
    const name = await resolveUserFn(ev.user, client).catch(() => ev.user);
    const prompt = `[${name} reacted with :${ev.reaction}: to your message]`;

    try {
      const { result, usage, totalCostUsd } = await runner(prompt, sessionKey);
      await chatTokenReporter.recordSession(usage, totalCostUsd);
      const { cleaned, markers } = parseMarkers(result);

      const isSilent = markers.some((m) => m.type === "silent");
      if (isSilent) {
        console.log("[slack] reaction_added: silent response — not posting");
        return;
      }

      let postResult: unknown;
      if (cleaned.trim().length > 0) {
        const blocks = blocksConverter(cleaned);
        if (blocks) {
          try {
            postResult = await client.chat.postMessage({
              channel: ev.item.channel,
              text: blocks.text,
              blocks: blocks.blocks,
            });
          } catch (err: unknown) {
            if (isInvalidBlocksError(err)) {
              console.warn("[slack] invalid_blocks — retrying with plain text");
              postResult = await client.chat
                .postMessage({
                  channel: ev.item.channel,
                  text: blocks.text || formatter(cleaned),
                })
                .catch((err2: unknown) => {
                  console.warn(
                    "[slack] reaction_added: postMessage failed:",
                    err2,
                  );
                  return undefined;
                });
            } else {
              console.warn("[slack] reaction_added: postMessage failed:", err);
              postResult = undefined;
            }
          }
        } else {
          postResult = await client.chat
            .postMessage({ channel: ev.item.channel, text: formatter(cleaned) })
            .catch((err: unknown) => {
              console.warn("[slack] reaction_added: postMessage failed:", err);
              return undefined;
            });
        }
      }

      const postedTs = (postResult as { ts?: string } | undefined)?.ts;
      await dispatchMarkers(markers, {
        client,
        channel: ev.item.channel,
        postedTs,
        threadTs: ev.item.ts,
        synthesizeSpeechFn,
        voiceConfig,
      });
    } catch (err) {
      console.error("[slack] reaction_added error:", err);
    }
  });

  return app;
}
