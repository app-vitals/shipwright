/**
 * admin/src/github-provisioning-service.ts
 * GithubProvisioningService — GitHub App manifest-flow / PAT provisioning
 * orchestration for connecting an already-existing agent to GitHub.
 *
 * Extracted out of admin-ui.ts's inline /admin/provision/* handlers (UAP-1.2)
 * so the same logic can be reused by both the legacy provisioning wizard
 * (POST /admin/provision/start GitHub branches, GET
 * /admin/provision/github-app/complete, GET
 * /admin/provision/github-app/installed) and the new per-agent
 * connect-github routes (POST /admin/agents/:id/connect-github, GET
 * .../callback, GET .../installed). Pure extraction — no behavior change.
 *
 * HTTP-specific mechanics (reading/writing the GITHUB_PROVISION_STATE_COOKIE,
 * issuing redirects, rendering HTML) stay in the route handlers; this service
 * owns the GitHub App manifest-flow API calls, the signed provision-state
 * token payload, and the env-var side effects (GH_TOKEN / GH_APP_ID /
 * GH_APP_INSTALLATION_ID / GH_APP_PRIVATE_KEY).
 *
 * Mirrors SlackProvisioningService's DI/result-union shape exactly
 * (slack-provisioning-service.ts) — see that file's header for the same
 * rationale, applied here to the GitHub side of provisioning.
 */

import { sign, verify } from "hono/jwt";
import type { AdminUIGithubAppClient } from "./admin-ui.ts";
import type { AgentCronJobService } from "./agent-cron-jobs.ts";
import type { AgentEnvService } from "./agent-envs.ts";
import type { AgentService } from "./agents.ts";
import { buildAgentAppManifest } from "./github-app-provisioning-client.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Signed cookie carrying provision state across the GitHub App manifest-flow redirect. */
export const GITHUB_PROVISION_STATE_COOKIE = "github_provision_state";
export const GITHUB_PROVISION_STATE_TTL_SECONDS = 300; // 5 min

/**
 * GitHub org login name pattern (matches GitHub's own username/org-name
 * rules: alphanumeric, single hyphens, no leading/trailing hyphen, max 39
 * chars). Operator-supplied `githubOrg` is validated against this at every
 * point it's about to be string-interpolated into a github.com redirect
 * URL — an open-redirect/injection boundary, not defensive-for-no-reason.
 */
export const GITHUB_ORG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]){0,38}$/;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GithubAppProvisionStatePayload {
  agentId: string;
  githubOrg: string;
}

export type StartPatConnectResult =
  | { ok: true; agentId: string }
  | { ok: false; agentId: string; error: string };

export type StartAppManualConnectResult =
  | { ok: true; agentId: string }
  | { ok: false; agentId: string; error: string };

export type StartAppAutoConnectResult =
  | {
      ok: true;
      /** Signed JWT to store in the GITHUB_PROVISION_STATE_COOKIE. */
      provisionStateToken: string;
      /** GitHub App manifest-creation form target + hidden manifest field. */
      githubOrg: string;
      manifest: ReturnType<typeof buildAgentAppManifest>;
    }
  | { ok: false; error: string };

export type CompleteConnectResult =
  | {
      /** Provision-state cookie missing or invalid/expired — restart the flow. */
      outcome: "invalid_state";
      error: string;
    }
  | {
      /** Valid state but no manifest code param (e.g. user cancelled). Cookie must NOT be cleared by the caller in this case. */
      outcome: "missing_code";
      error: string;
    }
  | {
      /** State cookie belongs to a different agent than the one in the URL. */
      outcome: "agent_mismatch";
      error: string;
    }
  | {
      /** Manifest code exchange with GitHub failed. */
      outcome: "exchange_failed";
      error: string;
    }
  | {
      /** Success — App credentials stored, show the install link next. */
      outcome: "success";
      agentId: string;
      installUrl: string;
    };

export type CompleteInstalledResult =
  | {
      /** Provision-state cookie missing or invalid/expired — restart the flow. */
      outcome: "invalid_state";
      error: string;
    }
  | {
      /** State cookie belongs to a different agent than the one in the URL. */
      outcome: "agent_mismatch";
      error: string;
    }
  | {
      /** Missing/non-numeric installation_id query param. */
      outcome: "invalid_installation_id";
      error: string;
    }
  | {
      /** Success — installation ID stored. */
      outcome: "success";
      agentId: string;
    };

export interface GithubProvisioningServiceDeps {
  githubAppClient: AdminUIGithubAppClient;
  agentService: Pick<AgentService, "getDetail">;
  agentEnvService: Pick<AgentEnvService, "patch">;
  agentCronJobService: Pick<AgentCronJobService, "reconcileSystemCrons">;
  sessionSecret: string;
  appBaseUrl: string;
  /** Env var keys that must be stored as secrets — mirrors SECRET_ENV_VARS. */
  secretEnvVars: Set<string>;
}

// ─── Validation helpers ─────────────────────────────────────────────────────

function isNumericId(value: string | undefined): value is string {
  return Boolean(value) && /^\d+$/.test(value as string);
}

/** Validates a pasted GitHub App ID (numeric string). */
export function isValidGithubAppId(value: string | undefined): value is string {
  return isNumericId(value);
}

/** Validates a pasted GitHub App Installation ID (numeric string). */
export function isValidGithubAppInstallationId(
  value: string | undefined,
): value is string {
  return isNumericId(value);
}

/** Validates a pasted GitHub App private key (PEM-encoded). */
export function isValidGithubAppPrivateKey(
  value: string | undefined,
): value is string {
  return Boolean(value?.includes("BEGIN") && value.includes("PRIVATE KEY"));
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class GithubProvisioningService {
  constructor(private readonly deps: GithubProvisioningServiceDeps) {}

  // ── PAT mode ────────────────────────────────────────────────────────────

  /**
   * Stores GH_TOKEN directly — no GitHub API call. Mirrors the ghAuthMode=pat
   * branch of the legacy POST /admin/provision/start handler.
   */
  async startPatConnect(
    agentId: string,
    ghPat: string | undefined,
  ): Promise<StartPatConnectResult> {
    if (!ghPat) {
      return {
        ok: false,
        agentId,
        error: "GitHub Personal Access Token is required.",
      };
    }

    const agent = await this.deps.agentService.getDetail(agentId);
    if (!agent) {
      return { ok: false, agentId, error: "Agent not found." };
    }

    await this.deps.agentEnvService.patch(
      agentId,
      { GH_TOKEN: ghPat },
      this.deps.secretEnvVars,
    );

    return { ok: true, agentId };
  }

  // ── App manual-paste mode ───────────────────────────────────────────────

  /**
   * Stores GH_APP_ID / GH_APP_INSTALLATION_ID / GH_APP_PRIVATE_KEY directly —
   * no GitHub API call. Mirrors the ghAuthMode=app + ghAppMode=manual branch
   * of the legacy POST /admin/provision/start handler.
   */
  async startAppManualConnect(
    agentId: string,
    fields: {
      ghAppId: string | undefined;
      ghAppInstallationId: string | undefined;
      ghAppPrivateKey: string | undefined;
    },
  ): Promise<StartAppManualConnectResult> {
    if (!isValidGithubAppId(fields.ghAppId)) {
      return {
        ok: false,
        agentId,
        error: "GitHub App ID must be a numeric value.",
      };
    }
    if (!isValidGithubAppInstallationId(fields.ghAppInstallationId)) {
      return {
        ok: false,
        agentId,
        error: "GitHub App Installation ID must be a numeric value.",
      };
    }
    if (!isValidGithubAppPrivateKey(fields.ghAppPrivateKey)) {
      return {
        ok: false,
        agentId,
        error: "GitHub App Private Key must be a valid PEM-encoded key.",
      };
    }

    const agent = await this.deps.agentService.getDetail(agentId);
    if (!agent) {
      return { ok: false, agentId, error: "Agent not found." };
    }

    await this.deps.agentEnvService.patch(
      agentId,
      {
        GH_APP_ID: fields.ghAppId,
        GH_APP_INSTALLATION_ID: fields.ghAppInstallationId,
        GH_APP_PRIVATE_KEY: fields.ghAppPrivateKey,
      },
      this.deps.secretEnvVars,
    );

    return { ok: true, agentId };
  }

  // ── App auto-provision (manifest flow) mode ─────────────────────────────

  /**
   * Signs a provision-state token (for the GITHUB_PROVISION_STATE_COOKIE)
   * carrying `agentId` + `githubOrg`. Exposed so the legacy wizard can fold
   * this into its own combined Slack+GitHub provision-state cookie via
   * `extra` on SlackProvisioningService.signProvisionState() instead, while
   * still using the same payload shape this service's completeConnect() /
   * completeInstalled() below expect.
   */
  async signProvisionState(
    agentId: string,
    githubOrg: string,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return sign(
      {
        agentId,
        githubOrg,
        iat: now,
        exp: now + GITHUB_PROVISION_STATE_TTL_SECONDS,
      },
      this.deps.sessionSecret,
      "HS256",
    );
  }

  /**
   * Builds the GitHub App manifest for `agentId` targeting `githubOrg`, and
   * returns a signed provision-state token (for the
   * GITHUB_PROVISION_STATE_COOKIE) plus the manifest for the auto-submitting
   * redirect page. Mirrors the ghAuthMode=app + ghAppMode=auto branch of the
   * legacy POST /admin/provision/start handler.
   *
   * `redirectUri`/`setupUrl` are supplied by the caller so both the legacy
   * wizard (targeting /admin/provision/github-app/*) and the new per-agent
   * routes (targeting /admin/agents/:id/connect-github/*) can reuse this
   * same manifest-building logic while pointing GitHub at different URLs.
   */
  async startAppAutoConnect(
    agentId: string,
    githubOrg: string | undefined,
    urls: { redirectUri: string; setupUrl: string },
  ): Promise<StartAppAutoConnectResult> {
    if (!githubOrg || !GITHUB_ORG_PATTERN.test(githubOrg)) {
      return {
        ok: false,
        error: "GitHub org must be a valid GitHub organization name.",
      };
    }

    const agent = await this.deps.agentService.getDetail(agentId);
    if (!agent) {
      return { ok: false, error: "Agent not found." };
    }

    const provisionStateToken = await this.signProvisionState(
      agentId,
      githubOrg,
    );
    const manifest = buildAgentAppManifest(agent.name, {
      redirectUri: urls.redirectUri,
      setupUrl: urls.setupUrl,
    });

    return { ok: true, provisionStateToken, githubOrg, manifest };
  }

  /**
   * Verifies the provision-state token payload shape (agentId + githubOrg).
   * Exposed so route handlers can additionally check the state's agentId
   * matches the :id URL param before calling completeConnect()/
   * completeInstalled() below.
   */
  async readProvisionState(
    rawStateCookie: string | undefined,
  ): Promise<
    | { ok: true; state: GithubAppProvisionStatePayload }
    | { ok: false; error: string }
  > {
    if (!rawStateCookie) {
      return {
        ok: false,
        error:
          "Provision session expired or missing. Please start the provisioning flow again.",
      };
    }
    try {
      const payload = (await verify(
        rawStateCookie,
        this.deps.sessionSecret,
        "HS256",
      )) as Record<string, unknown>;
      if (
        typeof payload.agentId !== "string" ||
        typeof payload.githubOrg !== "string" ||
        !GITHUB_ORG_PATTERN.test(payload.githubOrg)
      ) {
        throw new Error("invalid payload shape");
      }
      return {
        ok: true,
        state: { agentId: payload.agentId, githubOrg: payload.githubOrg },
      };
    } catch {
      return {
        ok: false,
        error:
          "Provision session expired or invalid. Please start the provisioning flow again.",
      };
    }
  }

  /**
   * Verifies the provision-state token, exchanges the manifest `code` for App
   * credentials, and stores GH_APP_ID + GH_APP_PRIVATE_KEY. Mirrors the
   * legacy GET /admin/provision/github-app/complete handler exactly.
   *
   * `expectedAgentId`, when provided, is checked against the state's agentId
   * (per-agent connect-github routes pass the :id URL param here) —
   * "agent_mismatch" is returned rather than proceeding cross-agent. The
   * legacy wizard route (no per-agent scoping) omits it.
   *
   * `installUrl` slug interpolation stays here (not the route) — it's a
   * business decision about the exchange result shape, not HTTP mechanics.
   */
  async completeConnect(
    rawStateCookie: string | undefined,
    code: string | undefined,
    expectedAgentId?: string,
  ): Promise<CompleteConnectResult> {
    const stateResult = await this.readProvisionState(rawStateCookie);
    if (!stateResult.ok) {
      return { outcome: "invalid_state", error: stateResult.error };
    }
    const state = stateResult.state;

    if (expectedAgentId !== undefined && state.agentId !== expectedAgentId) {
      return {
        outcome: "agent_mismatch",
        error: "Provision session does not match this agent.",
      };
    }

    if (!code) {
      return {
        outcome: "missing_code",
        error:
          "GitHub did not return a manifest code. Please restart the provisioning flow from the beginning.",
      };
    }

    let exchangeResult: {
      appId: string;
      slug: string;
      pem: string;
      clientId: string;
      clientSecret: string;
    };
    try {
      exchangeResult =
        await this.deps.githubAppClient.exchangeManifestCode(code);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "Unknown error exchanging GitHub App manifest code.";
      return {
        outcome: "exchange_failed",
        error: `GitHub App creation failed: ${msg}`,
      };
    }

    await this.deps.agentEnvService.patch(
      state.agentId,
      {
        GH_APP_ID: exchangeResult.appId,
        GH_APP_PRIVATE_KEY: exchangeResult.pem,
        GH_APP_CLIENT_ID: exchangeResult.clientId,
        GH_APP_CLIENT_SECRET: exchangeResult.clientSecret,
      },
      this.deps.secretEnvVars,
    );

    return {
      outcome: "success",
      agentId: state.agentId,
      installUrl: `https://github.com/apps/${exchangeResult.slug}/installations/new`,
    };
  }

  /**
   * Verifies the provision-state token, stores GH_APP_INSTALLATION_ID, and
   * reconciles system crons (best-effort, non-fatal — mirrors
   * SlackProvisioningService.saveAppToken()'s parity call). Mirrors the
   * legacy GET /admin/provision/github-app/installed handler's env write
   * exactly, with the cron reconcile added on top (UAP-1.4).
   * `expectedAgentId` behaves as in completeConnect() above.
   */
  async completeInstalled(
    rawStateCookie: string | undefined,
    installationId: string | undefined,
    expectedAgentId?: string,
  ): Promise<CompleteInstalledResult> {
    const stateResult = await this.readProvisionState(rawStateCookie);
    if (!stateResult.ok) {
      return { outcome: "invalid_state", error: stateResult.error };
    }
    const state = stateResult.state;

    if (expectedAgentId !== undefined && state.agentId !== expectedAgentId) {
      return {
        outcome: "agent_mismatch",
        error: "Provision session does not match this agent.",
      };
    }

    if (!isNumericId(installationId)) {
      return {
        outcome: "invalid_installation_id",
        error:
          "GitHub did not return a valid installation ID. Please restart the provisioning flow from the beginning.",
      };
    }

    await this.deps.agentEnvService.patch(state.agentId, {
      GH_APP_INSTALLATION_ID: installationId,
    });

    // Best-effort, mirroring the same call at agent boot (agent/src/index.ts)
    // and SlackProvisioningService.saveAppToken()'s parity call.
    // reconcileSystemCrons is a full three-pass reconcile, so a second run is
    // a no-op — and failing here would strand the operator next to a live
    // agent whose GitHub App install otherwise succeeded.
    try {
      await this.deps.agentCronJobService.reconcileSystemCrons(state.agentId);
    } catch (err) {
      console.error(
        "[github-provisioning-service] failed to reconcile system crons (non-fatal):",
        err,
      );
    }

    return { outcome: "success", agentId: state.agentId };
  }
}
