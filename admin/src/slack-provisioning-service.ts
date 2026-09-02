/**
 * admin/src/slack-provisioning-service.ts
 * SlackProvisioningService — Slack app-manifest-creation/OAuth orchestration
 * for connecting an already-existing agent to Slack.
 *
 * Extracted out of admin-ui.ts's inline /admin/provision/* handlers (UAP-1.1)
 * so the same logic can be reused by both the legacy provisioning wizard
 * (POST /admin/provision/start Slack branch, GET /admin/provision/complete,
 * POST /admin/provision/xapp-token) and the new per-agent connect-slack
 * routes (POST /admin/agents/:id/connect-slack, GET .../callback, POST
 * .../app-token). Pure extraction — no behavior change.
 *
 * HTTP-specific mechanics (reading/writing the PROVISION_STATE_COOKIE,
 * issuing redirects, rendering HTML) stay in the route handlers; this service
 * owns the Slack API calls, the signed provision-state token payload, and the
 * env/cron side effects.
 */

import { sign, verify } from "hono/jwt";
import type { AdminUISlackClient } from "./admin-ui.ts";
import type { AgentCronJobService } from "./agent-cron-jobs.ts";
import type { AgentEnvService } from "./agent-envs.ts";
import type { AgentService } from "./agents.ts";
import { buildAgentManifest } from "./slack-provisioning-client.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Shared with admin-ui.ts — the signed cookie carrying provision state across the Slack OAuth redirect. */
export const PROVISION_STATE_COOKIE = "slack_provision_state";
export const PROVISION_STATE_TTL_SECONDS = 300; // 5 min

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProvisionStatePayload {
  agentId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  appId: string;
  /**
   * The OAuth `redirect_uri` registered in the app manifest for this
   * provisioning attempt. Persisted so completeConnect() replays the exact
   * same value to `oauth.v2.access` (Slack requires the exchange's
   * `redirect_uri` to match a registered one). Optional for backwards
   * compatibility with any cookie signed before this field existed, in which
   * case the caller-supplied fallback is used.
   */
  redirectUri?: string;
}

export type StartConnectResult =
  | {
      ok: true;
      /** Signed JWT to store in the PROVISION_STATE_COOKIE. */
      provisionStateToken: string;
      /** Slack OAuth v2 authorize URL to redirect the operator to. */
      oauthRedirectUrl: string;
    }
  | { ok: false; error: string };

export type CompleteConnectResult =
  | {
      /** Provision-state cookie missing or invalid/expired — restart the flow. */
      outcome: "invalid_state";
      error: string;
    }
  | {
      /** Valid state but no OAuth code param (e.g. user denied consent). Cookie must NOT be cleared by the caller in this case. */
      outcome: "missing_code";
      error: string;
    }
  | {
      /** OAuth code exchange with Slack failed. */
      outcome: "exchange_failed";
      error: string;
    }
  | {
      /** Success, and this is a reinstall (SLACK_APP_TOKEN was already set) — redirect straight to the agent page. */
      outcome: "reinstalled";
      agentId: string;
      /**
       * Set only for the combined create+connect flow (UAP-2.1): a non-fatal
       * GitHub PAT storage failure that happened before this Slack flow began.
       * The caller surfaces it as a warning on the landing page so the operator
       * isn't misled into believing GH_TOKEN was stored.
       */
      ghConnectError?: string;
    }
  | {
      /** Success, fresh provisioning — show the xapp-token page next. */
      outcome: "needs_app_token";
      agentId: string;
      /** See `reinstalled.ghConnectError` — same non-fatal combined-flow warning. */
      ghConnectError?: string;
    };

export type SaveAppTokenResult =
  | { ok: true; agentId: string }
  | { ok: false; agentId: string; error: string };

export interface SlackAppManifestResult {
  appId: string;
  oauthRedirectUrl: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
}

export interface SlackProvisioningServiceDeps {
  slackClient: AdminUISlackClient;
  agentService: Pick<AgentService, "getDetail" | "updateFields">;
  agentEnvService: Pick<AgentEnvService, "patch" | "getConfigBundle">;
  agentCronJobService: Pick<AgentCronJobService, "reconcileSystemCrons">;
  sessionSecret: string;
  appBaseUrl: string;
  /** Env var keys that must be stored as secrets — mirrors SECRET_ENV_VARS. */
  secretEnvVars: Set<string>;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class SlackProvisioningService {
  constructor(private readonly deps: SlackProvisioningServiceDeps) {}

  /**
   * Calls apps.manifest.create for `agentName` and returns the raw Slack
   * result (app id, OAuth authorize URL, and OAuth credentials). Low-level
   * building block shared by startConnect() below and by the legacy POST
   * /admin/provision/start wizard's Slack branch — the wizard needs the raw
   * credentials to sign its own provision-state cookie (which additionally
   * carries `githubOrg` for the GitHub-App-auto-provision sub-flow), so it
   * calls this instead of startConnect().
   *
   * `redirectUri` is supplied by the caller and becomes the manifest's OAuth
   * `redirect_urls` entry, so both the legacy wizard (passing
   * `/admin/provision/complete`) and the new per-agent connect-slack route
   * (passing `/admin/agents/:id/connect-slack/callback`) can reuse this same
   * manifest-building logic while registering different OAuth callback URLs
   * with Slack. Slack requires the `redirect_uri` sent to `oauth.v2.access`
   * to match one of the app's registered `redirect_urls`, so the same value
   * must be threaded through to completeConnect()'s exchange call below.
   */
  async createAppManifest(
    agentName: string,
    xoxpToken: string,
    redirectUri: string,
  ): Promise<SlackAppManifestResult> {
    const manifest = buildAgentManifest(agentName, redirectUri);
    return this.deps.slackClient.createAppManifest(xoxpToken, manifest);
  }

  /**
   * Signs a provision-state token (for the PROVISION_STATE_COOKIE) carrying
   * the given Slack OAuth credentials for `agentId`. Exposed so the legacy
   * wizard can fold its own extra `githubOrg` field into the same signed
   * payload shape that completeConnect() below verifies.
   */
  async signProvisionState(
    agentId: string,
    creds: {
      clientId: string;
      clientSecret: string;
      signingSecret: string;
      appId: string;
      /**
       * The manifest's registered OAuth `redirect_uri` for this attempt,
       * replayed verbatim to `oauth.v2.access` by completeConnect().
       */
      redirectUri: string;
    },
    extra?: Record<string, unknown>,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return sign(
      {
        agentId,
        ...creds,
        iat: now,
        exp: now + PROVISION_STATE_TTL_SECONDS,
        ...extra,
      },
      this.deps.sessionSecret,
      "HS256",
    );
  }

  /**
   * Creates the Slack app manifest for `agentId` via apps.manifest.create and
   * returns a signed provision-state token (for the PROVISION_STATE_COOKIE)
   * plus the Slack OAuth authorize URL to redirect to.
   *
   * Mirrors the Slack branch of the legacy POST /admin/provision/start
   * handler (validation + apps.manifest.create + cookie payload), but for an
   * agent that already exists — no agent-creation/rollback orchestration.
   *
   * `redirectUri` is threaded through to createAppManifest() (registered as
   * the app's OAuth `redirect_urls`) and folded into the signed
   * provision-state cookie so completeConnect() can replay the identical URL
   * to `oauth.v2.access` — Slack rejects an exchange whose `redirect_uri`
   * doesn't match a registered one. The per-agent connect-slack route passes
   * its own `/admin/agents/:id/connect-slack/callback` here.
   *
   * `ghConnectError` (UAP-2.1) is an optional non-fatal GitHub PAT storage
   * failure from the combined create+connect flow. When present it's folded
   * into the signed provision-state cookie so it survives Slack's OAuth round
   * trip and completeConnect() can hand it back to the caller to surface on the
   * post-callback landing page — otherwise the failure would be silently
   * swallowed and the operator misled into believing GH_TOKEN was stored.
   */
  async startConnect(
    agentId: string,
    xoxpToken: string | undefined,
    redirectUri: string,
    ghConnectError?: string,
  ): Promise<StartConnectResult> {
    if (!xoxpToken || !xoxpToken.startsWith("xoxe.xoxp-")) {
      return {
        ok: false,
        error: "Slack app configuration token must start with xoxe.xoxp-",
      };
    }

    const agent = await this.deps.agentService.getDetail(agentId);
    if (!agent) {
      return { ok: false, error: "Agent not found." };
    }

    let slackResult: SlackAppManifestResult;
    try {
      slackResult = await this.createAppManifest(
        agent.name,
        xoxpToken,
        redirectUri,
      );
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "Unknown error creating Slack app.";
      return { ok: false, error: msg };
    }

    const { appId, oauthRedirectUrl, clientId, clientSecret, signingSecret } =
      slackResult;

    const provisionStateToken = await this.signProvisionState(
      agentId,
      {
        clientId,
        clientSecret,
        signingSecret,
        appId,
        redirectUri,
      },
      ghConnectError ? { ghConnectError } : undefined,
    );

    return { ok: true, provisionStateToken, oauthRedirectUrl };
  }

  /**
   * Verifies the provision-state token, exchanges the OAuth `code` for a bot
   * token, and stores SLACK_BOT_TOKEN. Mirrors the legacy
   * GET /admin/provision/complete handler exactly.
   *
   * The caller (route handler) is responsible for reading the raw cookie
   * value and for clearing it — this method never has cookie access; it only
   * decides whether the "invalid state" outcome should tell the caller to
   * clear the cookie (yes, for invalid_state) or not (no, for missing_code,
   * where the cookie must survive a retry).
   *
   * `fallbackRedirectUri` is used for the OAuth exchange only when the signed
   * state cookie predates the `redirectUri` field (cookies signed before this
   * fix). New cookies carry their own per-flow redirect URI, so callers pass
   * their own flow's URL as the fallback to preserve behavior for in-flight
   * legacy sessions.
   */
  async completeConnect(
    rawStateCookie: string | undefined,
    code: string | undefined,
    fallbackRedirectUri: string,
  ): Promise<CompleteConnectResult> {
    if (!rawStateCookie) {
      return {
        outcome: "invalid_state",
        error:
          "Provision session expired or missing. Please start the provisioning flow again.",
      };
    }

    let provisionState: ProvisionStatePayload;
    // Non-fatal combined-flow warning (UAP-2.1), threaded through the signed
    // cookie so it survives Slack's OAuth round trip. Declared out here so it
    // escapes the verify() try block; kept separate from the
    // ProvisionStatePayload shape since it's flow-specific, not Slack state.
    let ghConnectError: string | undefined;
    try {
      const payload = (await verify(
        rawStateCookie,
        this.deps.sessionSecret,
        "HS256",
      )) as Record<string, unknown>;
      if (
        typeof payload.agentId !== "string" ||
        typeof payload.clientId !== "string" ||
        typeof payload.clientSecret !== "string" ||
        typeof payload.signingSecret !== "string" ||
        typeof payload.appId !== "string"
      ) {
        throw new Error("invalid payload shape");
      }
      provisionState = {
        agentId: payload.agentId,
        clientId: payload.clientId,
        clientSecret: payload.clientSecret,
        signingSecret: payload.signingSecret,
        appId: payload.appId,
        redirectUri:
          typeof payload.redirectUri === "string"
            ? payload.redirectUri
            : undefined,
      };
      ghConnectError =
        typeof payload.ghConnectError === "string"
          ? payload.ghConnectError
          : undefined;
    } catch {
      return {
        outcome: "invalid_state",
        error:
          "Provision session expired or invalid. Please start the provisioning flow again.",
      };
    }

    if (!code) {
      return {
        outcome: "missing_code",
        error:
          "Authorization was not completed (no OAuth code received). Please restart the provisioning flow from the beginning.",
      };
    }

    let botToken: string;
    let slackUserId: string;
    try {
      const result = await this.deps.slackClient.exchangeOAuthCode(
        code,
        provisionState.clientId,
        provisionState.clientSecret,
        provisionState.redirectUri ?? fallbackRedirectUri,
      );
      botToken = result.botToken;

      // Resolve the bot's own Slack user id so it can be persisted to
      // agent.slackId (UAP-1.3) — required for the Sync Manifest button to
      // appear. Folded into the same try/catch as the exchange: an auth.test
      // failure right after a successful exchange is treated the same as an
      // exchange failure so the flow doesn't half-complete with a bot token
      // stored but no resolved slackId.
      const authTestResult = await this.deps.slackClient.authTest(botToken);
      slackUserId = authTestResult.userId;
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "Unknown error exchanging OAuth code.";
      return {
        outcome: "exchange_failed",
        error: `OAuth exchange failed: ${msg}`,
      };
    }

    const existingBundle = await this.deps.agentEnvService.getConfigBundle(
      provisionState.agentId,
    );
    await this.deps.agentEnvService.patch(
      provisionState.agentId,
      { SLACK_BOT_TOKEN: botToken },
      this.deps.secretEnvVars,
    );

    // Persist unconditionally on every successful completion (both
    // "reinstalled" and "needs_app_token" outcomes) — a bot reinstall can
    // also resolve a fresh/different user id.
    await this.deps.agentService.updateFields(provisionState.agentId, {
      slackId: slackUserId,
    });

    if (existingBundle?.env.SLACK_APP_TOKEN) {
      return {
        outcome: "reinstalled",
        agentId: provisionState.agentId,
        ghConnectError,
      };
    }

    return {
      outcome: "needs_app_token",
      agentId: provisionState.agentId,
      ghConnectError,
    };
  }

  /**
   * Stores SLACK_APP_TOKEN and reconciles system crons. Mirrors the legacy
   * POST /admin/provision/xapp-token handler exactly.
   */
  async saveAppToken(
    agentId: string | undefined,
    xappToken: string | undefined,
  ): Promise<SaveAppTokenResult> {
    if (!agentId) {
      return { ok: false, agentId: "", error: "Agent ID is required." };
    }

    if (!xappToken || !xappToken.startsWith("xapp-")) {
      return {
        ok: false,
        agentId,
        error: "App-Level Token must start with xapp-",
      };
    }

    try {
      // SHIPWRIGHT_AGENT_API_KEY and SHIPWRIGHT_TASK_STORE_TOKEN are NOT minted
      // here. K8s-managed agents already have both minted straight into the K8s
      // Secret by provisioner.provision() (agent-provisioner.ts) — that Secret is
      // the sole source of truth (via secretKeyRef in the Deployment manifest).
      // Self-hosted agents never run the containerized entrypoint that reads
      // SHIPWRIGHT_AGENT_API_KEY (agent/src/entrypoint.ts), and use the
      // GitHub-backed task-store CLI config instead of a bearer token, so they
      // don't need either key in AgentEnv. Minting them here previously orphaned
      // a second, different, unused live credential per key on every provision.
      await this.deps.agentEnvService.patch(
        agentId,
        { SLACK_APP_TOKEN: xappToken },
        this.deps.secretEnvVars,
      );

      await this.deps.agentCronJobService.reconcileSystemCrons(agentId);

      return { ok: true, agentId };
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "Unknown error completing provisioning.";
      return { ok: false, agentId, error: msg };
    }
  }
}
