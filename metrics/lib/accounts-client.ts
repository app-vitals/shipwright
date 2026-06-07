/**
 * lib/accounts-client.ts
 * Typed HTTP client for the Accounts API.
 *
 * Usage:
 *   const client = new HttpAccountsClient('http://accounts-api:3458', process.env.VITALS_OS_API_KEY);
 *   const users = await client.listUsers();
 *   const conn = await client.getOAuthConnection(userId, 'GOOGLE');
 */

import createClient, { type Client } from "openapi-fetch";
import type { components, paths } from "./accounts-types.ts";

// ─── Public types ─────────────────────────────────────────────────────────────

export type UserRecord = components["schemas"]["UserRecord"];
export type ClientRecord = components["schemas"]["ClientRecord"];
export type ClientDetailRecord = components["schemas"]["ClientDetailRecord"];
export type EngagementRecord = components["schemas"]["EngagementRecord"];
export type OAuthConnectionRecord =
  components["schemas"]["OAuthConnectionRecord"];
export type ConnectionRecord = components["schemas"]["ConnectionRecord"];
export type CreateUserInput = components["schemas"]["CreateUserInput"];
export type UpdateUserInput = components["schemas"]["UpdateUserInput"];
export type CreateClientInput = components["schemas"]["CreateClientInput"];
export type UpdateClientInput = components["schemas"]["UpdateClientInput"];
export type CreateEngagementInput =
  components["schemas"]["CreateEngagementInput"];
export type UpdateEngagementInput =
  components["schemas"]["UpdateEngagementInput"];
export type AgentEnvRecord = components["schemas"]["AgentEnvRecord"];
export type UpsertAgentEnvInput = components["schemas"]["UpsertAgentEnvInput"];
export type AgentEnvBundle = components["schemas"]["AgentEnvBundle"];
export type AgentTokenCreatedResponse =
  components["schemas"]["AgentTokenCreatedResponse"];
export type TeamRecord = components["schemas"]["TeamRecord"];
export type AgentCronJobRecord = components["schemas"]["AgentCronJobRecord"];
export type CreateAgentCronJobInput =
  components["schemas"]["CreateAgentCronJobInput"];
export type UpdateAgentCronJobInput =
  components["schemas"]["UpdateAgentCronJobInput"];
export type ReconcileSystemCronsResult =
  components["schemas"]["ReconcileSystemCronsResult"];

// ─── Error type ───────────────────────────────────────────────────────────────

export class AccountsClientError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(`[${statusCode}] ${message}`);
    this.name = "AccountsClientError";
  }
}

// ─── Interface for test injection ─────────────────────────────────────────────

export interface AccountsClient {
  listUsers(): Promise<UserRecord[]>;
  getUser(id: string): Promise<UserRecord>;
  createUser(input: CreateUserInput): Promise<UserRecord>;
  updateUser(id: string, input: UpdateUserInput): Promise<UserRecord>;
  listClients(): Promise<ClientRecord[]>;
  getClient(id: string): Promise<ClientDetailRecord>;
  createClient(input: CreateClientInput): Promise<ClientDetailRecord>;
  updateClient(
    id: string,
    input: UpdateClientInput,
  ): Promise<ClientDetailRecord>;
  deleteClient(id: string): Promise<void>;
  listEngagements(filters?: {
    status?: "ACTIVE" | "PAUSED" | "CLOSED";
    clientId?: string;
  }): Promise<EngagementRecord[]>;
  getEngagement(id: string): Promise<EngagementRecord>;
  createEngagement(input: CreateEngagementInput): Promise<EngagementRecord>;
  updateEngagement(
    id: string,
    input: UpdateEngagementInput,
  ): Promise<EngagementRecord>;
  deleteEngagement(id: string): Promise<void>;
  listOAuthConnections(userId: string): Promise<OAuthConnectionRecord[]>;
  getOAuthConnection(
    userId: string,
    provider: string,
  ): Promise<OAuthConnectionRecord | null>;
  deleteOAuthConnection(userId: string, provider: string): Promise<boolean>;
  getOAuthToken(
    userId: string,
    provider: string,
  ): Promise<{ accessToken: string; expiresAt: string }>;
  listConnections(filters?: {
    provider?: string;
    clientId?: string;
  }): Promise<ConnectionRecord[]>;
  getConnectionToken(
    id: string,
  ): Promise<{ accessToken: string; expiresAt: string }>;
  getAgentEnv(agentId: string): Promise<AgentEnvRecord>;
  upsertAgentEnv(
    agentId: string,
    input: UpsertAgentEnvInput,
  ): Promise<AgentEnvRecord>;
  patchAgentEnv(
    agentId: string,
    input: UpsertAgentEnvInput,
  ): Promise<AgentEnvRecord>;
  getAgentConfigBundle(agentId: string): Promise<AgentEnvBundle>;
  listAgentEnvs(): Promise<AgentEnvRecord[]>;
  createAgentToken(
    userId: string,
    clientId: string,
    label?: string,
  ): Promise<AgentTokenCreatedResponse>;
  getTeam(id: string): Promise<TeamRecord | null>;
  listTeams(): Promise<TeamRecord[]>;
  listEnabledCronJobs(): Promise<AgentCronJobRecord[]>;
  listAgentCronJobs(agentId: string): Promise<AgentCronJobRecord[]>;
  createAgentCronJob(
    agentId: string,
    input: CreateAgentCronJobInput,
  ): Promise<AgentCronJobRecord>;
  deleteAgentCronJob(agentId: string, cronId: string): Promise<void>;
  setAgentCronJobEnabled(
    agentId: string,
    cronId: string,
    enabled: boolean,
  ): Promise<AgentCronJobRecord>;
  validateAgentToken(
    token: string,
  ): Promise<{ userId: string; clientId: string } | null>;
  reconcileSystemCrons(agentId: string): Promise<ReconcileSystemCronsResult>;
}

// ─── Client implementation ────────────────────────────────────────────────────

export class HttpAccountsClient implements AccountsClient {
  private http: Client<paths>;

  constructor(baseUrl: string, apiKey: string) {
    this.http = createClient<paths>({
      baseUrl,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  }

  // ─── Users ─────────────────────────────────────────────────────────────────

  async listUsers(): Promise<UserRecord[]> {
    const { data, error, response } = await this.http.GET("/accounts/users");
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ?? "listUsers failed",
      );
    }
    return data;
  }

  async getUser(id: string): Promise<UserRecord> {
    const { data, error, response } = await this.http.GET(
      "/accounts/users/{id}",
      { params: { path: { id } } },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ?? "getUser failed",
      );
    }
    return data;
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const { data, error, response } = await this.http.POST("/accounts/users", {
      body: input,
    });
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ?? "createUser failed",
      );
    }
    return data;
  }

  async updateUser(id: string, input: UpdateUserInput): Promise<UserRecord> {
    const { data, error, response } = await this.http.PATCH(
      "/accounts/users/{id}",
      { params: { path: { id } }, body: input },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ?? "updateUser failed",
      );
    }
    return data;
  }

  // ─── Clients ───────────────────────────────────────────────────────────────

  async listClients(): Promise<ClientRecord[]> {
    const { data, error, response } = await this.http.GET("/accounts/clients");
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "listClients failed",
      );
    }
    return data;
  }

  async getClient(id: string): Promise<ClientDetailRecord> {
    const { data, error, response } = await this.http.GET(
      "/accounts/clients/{id}",
      { params: { path: { id } } },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ?? "getClient failed",
      );
    }
    return data;
  }

  async createClient(input: CreateClientInput): Promise<ClientDetailRecord> {
    const { data, error, response } = await this.http.POST(
      "/accounts/clients",
      { body: input },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "createClient failed",
      );
    }
    return data;
  }

  async updateClient(
    id: string,
    input: UpdateClientInput,
  ): Promise<ClientDetailRecord> {
    const { data, error, response } = await this.http.PATCH(
      "/accounts/clients/{id}",
      { params: { path: { id } }, body: input },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "updateClient failed",
      );
    }
    return data;
  }

  async deleteClient(id: string): Promise<void> {
    const { response } = await this.http.DELETE("/accounts/clients/{id}", {
      params: { path: { id } },
    });
    if (response.status === 204) return;
    throw new AccountsClientError(response.status, "deleteClient failed");
  }

  // ─── Engagements ───────────────────────────────────────────────────────────

  async listEngagements(filters?: {
    status?: "ACTIVE" | "PAUSED" | "CLOSED";
    clientId?: string;
  }): Promise<EngagementRecord[]> {
    const { data, error, response } = await this.http.GET(
      "/accounts/engagements",
      {
        params: {
          query: {
            status: filters?.status,
            clientId: filters?.clientId,
          },
        },
      },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "listEngagements failed",
      );
    }
    return data;
  }

  async getEngagement(id: string): Promise<EngagementRecord> {
    const { data, error, response } = await this.http.GET(
      "/accounts/engagements/{id}",
      { params: { path: { id } } },
    );
    if (error ?? !data) {
      const msg =
        (error as { error?: string } | undefined)?.error ??
        "getEngagement failed";
      console.error(
        `accounts GET /engagements/${id} → ${response.status}: ${msg}`,
      );
      throw new AccountsClientError(response.status, msg);
    }
    return data;
  }

  async createEngagement(
    input: CreateEngagementInput,
  ): Promise<EngagementRecord> {
    const { data, error, response } = await this.http.POST(
      "/accounts/engagements",
      { body: input },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "createEngagement failed",
      );
    }
    return data;
  }

  async updateEngagement(
    id: string,
    input: UpdateEngagementInput,
  ): Promise<EngagementRecord> {
    const { data, error, response } = await this.http.PATCH(
      "/accounts/engagements/{id}",
      { params: { path: { id } }, body: input },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "updateEngagement failed",
      );
    }
    return data;
  }

  async deleteEngagement(id: string): Promise<void> {
    const { response } = await this.http.DELETE("/accounts/engagements/{id}", {
      params: { path: { id } },
    });
    if (response.status === 204) return;
    throw new AccountsClientError(response.status, "deleteEngagement failed");
  }

  // ─── OAuth Connections ─────────────────────────────────────────────────────

  async listOAuthConnections(userId: string): Promise<OAuthConnectionRecord[]> {
    const { data, error, response } = await this.http.GET(
      "/accounts/oauth/{userId}",
      { params: { path: { userId } } },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "listOAuthConnections failed",
      );
    }
    return data;
  }

  async getOAuthConnection(
    userId: string,
    provider: string,
  ): Promise<OAuthConnectionRecord | null> {
    const { data, error, response } = await this.http.GET(
      "/accounts/oauth/{userId}/{provider}",
      { params: { path: { userId, provider } } },
    );
    if (response.status === 404) return null;
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "getOAuthConnection failed",
      );
    }
    return data;
  }

  async deleteOAuthConnection(
    userId: string,
    provider: string,
  ): Promise<boolean> {
    const { response } = await this.http.DELETE(
      "/accounts/oauth/{userId}/{provider}",
      { params: { path: { userId, provider } } },
    );
    if (response.status === 204) return true;
    if (response.status === 404) return false;
    throw new AccountsClientError(
      response.status,
      "deleteOAuthConnection failed",
    );
  }

  async getOAuthToken(
    userId: string,
    provider: string,
  ): Promise<{ accessToken: string; expiresAt: string }> {
    const { data, error, response } = await this.http.GET(
      "/accounts/oauth/{userId}/{provider}/token",
      { params: { path: { userId, provider } } },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "getOAuthToken failed",
      );
    }
    return data;
  }

  // ─── Connection management (MGC-2.2) ────────────────────────────────────────

  async listConnections(filters?: {
    provider?: string;
    clientId?: string;
  }): Promise<ConnectionRecord[]> {
    const { data, error, response } = await this.http.GET(
      "/accounts/connections",
      {
        params: {
          query: {
            provider: filters?.provider,
            clientId: filters?.clientId,
          },
        },
      },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "listConnections failed",
      );
    }
    return data;
  }

  async getConnectionToken(
    id: string,
  ): Promise<{ accessToken: string; expiresAt: string }> {
    const { data, error, response } = await this.http.GET(
      "/accounts/connections/{id}/token",
      { params: { path: { id } } },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "getConnectionToken failed",
      );
    }
    return data;
  }

  // ─── Agent Env ────────────────────────────────────────────────────────────

  async getAgentEnv(agentId: string): Promise<AgentEnvRecord> {
    const { data, error, response } = await this.http.GET(
      "/accounts/agent-envs/{agentId}",
      { params: { path: { agentId } } },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "getAgentEnv failed",
      );
    }
    return data;
  }

  async upsertAgentEnv(
    agentId: string,
    input: UpsertAgentEnvInput,
  ): Promise<AgentEnvRecord> {
    const { data, error, response } = await this.http.POST(
      "/accounts/agent-envs/{agentId}",
      { params: { path: { agentId } }, body: input },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "upsertAgentEnv failed",
      );
    }
    return data;
  }

  async patchAgentEnv(
    agentId: string,
    input: UpsertAgentEnvInput,
  ): Promise<AgentEnvRecord> {
    const { data, error, response } = await this.http.PATCH(
      "/accounts/agent-envs/{agentId}",
      { params: { path: { agentId } }, body: input },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "patchAgentEnv failed",
      );
    }
    return data;
  }

  async getAgentConfigBundle(agentId: string): Promise<AgentEnvBundle> {
    const { data, error, response } = await this.http.GET(
      "/accounts/agents/{agentId}/config",
      { params: { path: { agentId } } },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "getAgentConfigBundle failed",
      );
    }
    return data;
  }

  async listAgentEnvs(): Promise<AgentEnvRecord[]> {
    const { data, error, response } = await this.http.GET(
      "/accounts/agent-envs",
      {},
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "listAgentEnvs failed",
      );
    }
    return data;
  }

  async createAgentToken(
    userId: string,
    clientId: string,
    label?: string,
  ): Promise<AgentTokenCreatedResponse> {
    const { data, error, response } = await this.http.POST(
      "/accounts/users/{userId}/tokens",
      {
        params: { path: { userId } },
        body: { clientId, label },
      },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "createAgentToken failed",
      );
    }
    return data;
  }

  async getTeam(id: string): Promise<TeamRecord | null> {
    const { data, error, response } = await this.http.GET(
      "/accounts/teams/{id}",
      { params: { path: { id } } },
    );
    if (response.status === 404) return null;
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ?? "getTeam failed",
      );
    }
    return data;
  }

  async listTeams(): Promise<TeamRecord[]> {
    const { data, error, response } = await this.http.GET(
      "/accounts/teams",
      {},
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ?? "listTeams failed",
      );
    }
    return data;
  }

  // ─── Agent Cron Jobs (AC-1.4) ─────────────────────────────────────────────

  async listEnabledCronJobs(): Promise<AgentCronJobRecord[]> {
    const { data, error, response } = await this.http.GET(
      "/accounts/crons/enabled",
      {},
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "listEnabledCronJobs failed",
      );
    }
    return data;
  }

  async listAgentCronJobs(agentId: string): Promise<AgentCronJobRecord[]> {
    const { data, error, response } = await this.http.GET(
      "/accounts/agents/{agentId}/crons",
      { params: { path: { agentId } } },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "listAgentCronJobs failed",
      );
    }
    return data;
  }

  async createAgentCronJob(
    agentId: string,
    input: CreateAgentCronJobInput,
  ): Promise<AgentCronJobRecord> {
    const { data, error, response } = await this.http.POST(
      "/accounts/agents/{agentId}/crons",
      { params: { path: { agentId } }, body: input },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "createAgentCronJob failed",
      );
    }
    return data;
  }

  async deleteAgentCronJob(agentId: string, cronId: string): Promise<void> {
    const { response } = await this.http.DELETE(
      "/accounts/agents/{agentId}/crons/{cronId}",
      { params: { path: { agentId, cronId } } },
    );
    if (response.status !== 204) {
      throw new AccountsClientError(
        response.status,
        "deleteAgentCronJob failed",
      );
    }
  }

  async setAgentCronJobEnabled(
    agentId: string,
    cronId: string,
    enabled: boolean,
  ): Promise<AgentCronJobRecord> {
    const { data, error, response } = await this.http.PATCH(
      "/accounts/agents/{agentId}/crons/{cronId}",
      { params: { path: { agentId, cronId } }, body: { enabled } },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "setAgentCronJobEnabled failed",
      );
    }
    return data;
  }

  async validateAgentToken(
    token: string,
  ): Promise<{ userId: string; clientId: string } | null> {
    const { data, response } = await this.http.POST(
      "/accounts/users/tokens/validate",
      { body: { token } },
    );
    if (response.status === 401) return null;
    if (!data) {
      throw new AccountsClientError(
        response.status,
        "validateAgentToken failed",
      );
    }
    return data;
  }

  async reconcileSystemCrons(
    agentId: string,
  ): Promise<ReconcileSystemCronsResult> {
    const { data, error, response } = await this.http.POST(
      "/accounts/agents/{agentId}/crons/reconcile-system",
      { params: { path: { agentId } } },
    );
    if (error ?? !data) {
      throw new AccountsClientError(
        response.status,
        (error as { error?: string } | undefined)?.error ??
          "reconcileSystemCrons failed",
      );
    }
    return data;
  }
}
