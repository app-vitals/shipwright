/**
 * metrics/src/lib/accounts-client.ts
 * Slim port of the Accounts client for the metrics service.
 * Only includes what metrics/src actually uses: getUser, listUsers,
 * plus stubs for the full interface required by test doubles.
 *
 * Usage:
 *   const client = new HttpAccountsClient('http://accounts-api:3458', process.env.SHIPWRIGHT_API_KEY);
 *   const user = await client.getUser(userId);
 */


// ─── Inline types (no accounts-types.ts dependency) ──────────────────────────

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  slackId?: string | null;
  role: "OWNER" | "MEMBER" | "AGENT";
  workingHoursStart?: string;
  workingHoursEnd?: string;
  timezone?: string;
  mercuryCounterparty?: string | null;
  ownerUserId?: string | null;
  clientId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRecord {
  id: string;
  name: string;
}

export interface CronJobRecord {
  id: string;
  name?: string | null;
  prompt: string;
}

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

// ─── Slim interface (only what metrics needs) ─────────────────────────────────

export interface AccountsClient {
  getUser(id: string): Promise<UserRecord>;
  listUsers(): Promise<UserRecord[]>;
  listAgents(): Promise<AgentRecord[]>;
  // Stub methods for interface completeness (used in test doubles)
  createUser(input: unknown): Promise<UserRecord>;
  updateUser(id: string, input: unknown): Promise<UserRecord>;
  listClients(): Promise<unknown[]>;
  getClient(id: string): Promise<unknown>;
  createClient(input: unknown): Promise<unknown>;
  updateClient(id: string, input: unknown): Promise<unknown>;
  deleteClient(id: string): Promise<void>;
  listEngagements(filters?: unknown): Promise<unknown[]>;
  getEngagement(id: string): Promise<unknown>;
  createEngagement(input: unknown): Promise<unknown>;
  updateEngagement(id: string, input: unknown): Promise<unknown>;
  deleteEngagement(id: string): Promise<void>;
  listOAuthConnections(userId: string): Promise<unknown[]>;
  getOAuthConnection(userId: string, provider: string): Promise<unknown | null>;
  deleteOAuthConnection(userId: string, provider: string): Promise<unknown>;
  getOAuthToken(userId: string, provider: string): Promise<unknown>;
  listConnections(filters?: unknown): Promise<unknown[]>;
  getConnectionToken(id: string): Promise<unknown>;
  getAgentEnv(agentId: string): Promise<unknown>;
  upsertAgentEnv(agentId: string, input: unknown): Promise<unknown>;
  patchAgentEnv(agentId: string, input: unknown): Promise<unknown>;
  getAgentConfigBundle(agentId: string): Promise<unknown>;
  listAgentEnvs(): Promise<unknown[]>;
  createAgentToken(
    userId: string,
    clientId: string,
    label?: string,
  ): Promise<unknown>;
  getTeam(id: string): Promise<unknown | null>;
  listTeams(): Promise<unknown[]>;
  listEnabledCronJobs(): Promise<unknown[]>;
  listAgentCronJobs(agentId: string): Promise<CronJobRecord[]>;
  createAgentCronJob(agentId: string, input: unknown): Promise<unknown>;
  deleteAgentCronJob(agentId: string, cronId: string): Promise<void>;
  setAgentCronJobEnabled(
    agentId: string,
    cronId: string,
    enabled: boolean,
  ): Promise<unknown>;
  reconcileSystemCrons(
    agentId: string,
    input: unknown,
  ): Promise<{ created: number; updated: number; deleted: number }>;
  validateAgentToken(
    token: string,
  ): Promise<{ userId: string; clientId: string } | null>;
}

// ─── HTTP implementation ──────────────────────────────────────────────────────

/** Minimal `fetch` shape — injectable so the client is testable without
 * overriding any global (Bun shares the test process). Defaults to the
 * platform `fetch`. Mirrors admin-metrics-client.ts's `FetchLike`. */
export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export class HttpAccountsClient implements AccountsClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(baseUrl: string, apiKey: string, fetchImpl?: FetchLike) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  private async fetch<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new AccountsClientError(
        res.status,
        await res.text().catch(() => "unknown error"),
      );
    }
    return res.json() as Promise<T>;
  }

  async getUser(id: string): Promise<UserRecord> {
    return this.fetch<UserRecord>(`/accounts/users/${id}`);
  }

  async listUsers(): Promise<UserRecord[]> {
    return this.fetch<UserRecord[]>("/accounts/users");
  }

  async listAgents(): Promise<AgentRecord[]> {
    return this.fetch<AgentRecord[]>("/agents");
  }

  async createUser(_input: unknown): Promise<UserRecord> {
    throw new AccountsClientError(501, "not implemented");
  }

  async updateUser(_id: string, _input: unknown): Promise<UserRecord> {
    throw new AccountsClientError(501, "not implemented");
  }

  async listClients(): Promise<unknown[]> {
    throw new AccountsClientError(501, "not implemented");
  }

  async getClient(_id: string): Promise<unknown> {
    throw new AccountsClientError(501, "not implemented");
  }

  async createClient(_input: unknown): Promise<unknown> {
    throw new AccountsClientError(501, "not implemented");
  }

  async updateClient(_id: string, _input: unknown): Promise<unknown> {
    throw new AccountsClientError(501, "not implemented");
  }

  async deleteClient(_id: string): Promise<void> {
    throw new AccountsClientError(501, "not implemented");
  }

  async listEngagements(_filters?: unknown): Promise<unknown[]> {
    throw new AccountsClientError(501, "not implemented");
  }

  async getEngagement(_id: string): Promise<unknown> {
    throw new AccountsClientError(501, "not implemented");
  }

  async createEngagement(_input: unknown): Promise<unknown> {
    throw new AccountsClientError(501, "not implemented");
  }

  async updateEngagement(_id: string, _input: unknown): Promise<unknown> {
    throw new AccountsClientError(501, "not implemented");
  }

  async deleteEngagement(_id: string): Promise<void> {
    throw new AccountsClientError(501, "not implemented");
  }

  async listOAuthConnections(_userId: string): Promise<unknown[]> {
    throw new AccountsClientError(501, "not implemented");
  }

  async getOAuthConnection(
    _userId: string,
    _provider: string,
  ): Promise<unknown | null> {
    throw new AccountsClientError(501, "not implemented");
  }

  async deleteOAuthConnection(
    _userId: string,
    _provider: string,
  ): Promise<unknown> {
    throw new AccountsClientError(501, "not implemented");
  }

  async getOAuthToken(_userId: string, _provider: string): Promise<unknown> {
    throw new AccountsClientError(501, "not implemented");
  }

  async listConnections(_filters?: unknown): Promise<unknown[]> {
    throw new AccountsClientError(501, "not implemented");
  }

  async getConnectionToken(_id: string): Promise<unknown> {
    throw new AccountsClientError(501, "not implemented");
  }

  async getAgentEnv(_agentId: string): Promise<unknown> {
    throw new AccountsClientError(501, "not implemented");
  }

  async upsertAgentEnv(_agentId: string, _input: unknown): Promise<unknown> {
    throw new AccountsClientError(501, "not implemented");
  }

  async patchAgentEnv(_agentId: string, _input: unknown): Promise<unknown> {
    throw new AccountsClientError(501, "not implemented");
  }

  async getAgentConfigBundle(_agentId: string): Promise<unknown> {
    throw new AccountsClientError(501, "not implemented");
  }

  async listAgentEnvs(): Promise<unknown[]> {
    throw new AccountsClientError(501, "not implemented");
  }

  async createAgentToken(
    _userId: string,
    _clientId: string,
    _label?: string,
  ): Promise<unknown> {
    throw new AccountsClientError(501, "not implemented");
  }

  async getTeam(_id: string): Promise<unknown | null> {
    throw new AccountsClientError(501, "not implemented");
  }

  async listTeams(): Promise<unknown[]> {
    throw new AccountsClientError(501, "not implemented");
  }

  async listEnabledCronJobs(): Promise<unknown[]> {
    throw new AccountsClientError(501, "not implemented");
  }

  async listAgentCronJobs(agentId: string): Promise<CronJobRecord[]> {
    return this.fetch<CronJobRecord[]>(`/agents/${agentId}/crons`);
  }

  async createAgentCronJob(_agentId: string, _input: unknown): Promise<unknown> {
    throw new AccountsClientError(501, "not implemented");
  }

  async deleteAgentCronJob(_agentId: string, _cronId: string): Promise<void> {
    throw new AccountsClientError(501, "not implemented");
  }

  async setAgentCronJobEnabled(
    _agentId: string,
    _cronId: string,
    _enabled: boolean,
  ): Promise<unknown> {
    throw new AccountsClientError(501, "not implemented");
  }

  async reconcileSystemCrons(
    _agentId: string,
    _input: unknown,
  ): Promise<{ created: number; updated: number; deleted: number }> {
    throw new AccountsClientError(501, "not implemented");
  }

  async validateAgentToken(
    _token: string,
  ): Promise<{ userId: string; clientId: string } | null> {
    throw new AccountsClientError(501, "not implemented");
  }
}
