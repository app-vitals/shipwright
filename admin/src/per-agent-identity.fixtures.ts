/**
 * admin/src/per-agent-identity.fixtures.ts
 * Test support for per-agent identity provisioning (never imported by
 * production code):
 *
 *   - FakeAnthropicIdentityClient: an in-memory AnthropicIdentityClient that
 *     keeps service accounts and federation rules, enforces live-name
 *     uniqueness (409 → AnthropicConflictError) like the Admin API, and can
 *     fail any call once on demand.
 *   - InMemoryAgentIdentityStore: the AgentAnthropicIdentityService get/set
 *     contract plus the name allocator's allocate(), over a Map, with
 *     injectable save failures.
 *   - FaultyKubernetesClient: wraps a RecordedKubernetesClient so any method
 *     can fail once, and logs every call.
 *
 * All three append to an optional shared `events` log so tests can assert the
 * cross-system call order.
 */

import type {
  AgentAnthropicIdentity,
  AgentAnthropicIdentityUpdate,
} from "./agent-anthropic-identity.ts";
import {
  type AddServiceAccountToWorkspaceInput,
  AnthropicApiError,
  AnthropicConflictError,
  type AnthropicFederationRule,
  type AnthropicIdentityClient,
  type AnthropicServiceAccount,
  type AnthropicWorkspaceMember,
  type CreateFederationRuleInput,
  type CreateServiceAccountInput,
} from "./anthropic-identity-client.ts";
import { identityBaseName, identityName } from "./anthropic-identity-name.ts";
import { NotFoundError } from "./errors.ts";
import type {
  KubernetesClient,
  RecordedKubernetesClient,
} from "./kubernetes-client.ts";

const ARCHIVED_AT = "2026-10-01T00:00:00Z";

// ─── Anthropic identity client fake ───────────────────────────────────────────

export type AnthropicIdentityOperation = keyof AnthropicIdentityClient;

export interface FakeServiceAccount extends AnthropicServiceAccount {
  workspaces: string[];
}

export interface FakeFederationRule extends AnthropicFederationRule {
  input: CreateFederationRuleInput;
}

export class FakeAnthropicIdentityClient implements AnthropicIdentityClient {
  readonly serviceAccounts = new Map<string, FakeServiceAccount>();
  readonly rules = new Map<string, FakeFederationRule>();
  readonly calls: Array<{ op: AnthropicIdentityOperation; arg: unknown }> = [];
  private readonly failures = new Map<AnthropicIdentityOperation, Error>();
  private nextId = 1;

  constructor(private readonly events: string[] = []) {}

  /** Make the next call to `op` throw (default: a 500 AnthropicApiError). */
  failNext(op: AnthropicIdentityOperation, err?: Error): void {
    this.failures.set(op, err ?? new AnthropicApiError(op, 500));
  }

  liveServiceAccounts(): FakeServiceAccount[] {
    return [...this.serviceAccounts.values()].filter((s) => !s.archivedAt);
  }

  liveRules(): FakeFederationRule[] {
    return [...this.rules.values()].filter((r) => !r.archivedAt);
  }

  callsTo(op: AnthropicIdentityOperation): unknown[] {
    return this.calls.filter((c) => c.op === op).map((c) => c.arg);
  }

  /** Seed a live service account (e.g. one whose ID write was lost). */
  seedServiceAccount(name: string): FakeServiceAccount {
    const sa = { id: this.id("svac"), name, archivedAt: null, workspaces: [] };
    this.serviceAccounts.set(sa.id, sa);
    return sa;
  }

  /** Seed a live federation rule (e.g. one whose ID write was lost). */
  seedRule(input: CreateFederationRuleInput): FakeFederationRule {
    const rule = {
      id: this.id("fdrl"),
      name: input.name,
      archivedAt: null,
      input,
    };
    this.rules.set(rule.id, rule);
    return rule;
  }

  async createServiceAccount(
    input: CreateServiceAccountInput,
  ): Promise<AnthropicServiceAccount> {
    this.enter("createServiceAccount", input);
    if (this.liveServiceAccounts().some((s) => s.name === input.name)) {
      throw new AnthropicConflictError("createServiceAccount");
    }
    const { workspaces: _w, ...sa } = this.seedServiceAccount(input.name);
    return sa;
  }

  async addServiceAccountToWorkspace(
    input: AddServiceAccountToWorkspaceInput,
  ): Promise<AnthropicWorkspaceMember> {
    this.enter("addServiceAccountToWorkspace", input);
    const sa = this.serviceAccounts.get(input.serviceAccountId);
    if (!sa || sa.archivedAt) {
      throw new AnthropicApiError("addServiceAccountToWorkspace", 404);
    }
    if (sa.workspaces.includes(input.workspaceId)) {
      throw new AnthropicConflictError("addServiceAccountToWorkspace");
    }
    sa.workspaces.push(input.workspaceId);
    return {
      serviceAccountId: sa.id,
      workspaceId: input.workspaceId,
      workspaceRole: input.workspaceRole ?? "workspace_developer",
    };
  }

  async createFederationRule(
    input: CreateFederationRuleInput,
  ): Promise<AnthropicFederationRule> {
    this.enter("createFederationRule", input);
    if (this.liveRules().some((r) => r.name === input.name)) {
      throw new AnthropicConflictError("createFederationRule");
    }
    const { input: _i, ...rule } = this.seedRule(input);
    return rule;
  }

  async archiveFederationRule(
    ruleId: string,
  ): Promise<AnthropicFederationRule> {
    this.enter("archiveFederationRule", ruleId);
    const rule = this.rules.get(ruleId);
    if (!rule) throw new AnthropicApiError("archiveFederationRule", 404);
    rule.archivedAt = ARCHIVED_AT;
    return { id: rule.id, name: rule.name, archivedAt: rule.archivedAt };
  }

  async archiveServiceAccount(
    serviceAccountId: string,
  ): Promise<AnthropicServiceAccount> {
    this.enter("archiveServiceAccount", serviceAccountId);
    const sa = this.serviceAccounts.get(serviceAccountId);
    if (!sa) throw new AnthropicApiError("archiveServiceAccount", 404);
    sa.archivedAt = ARCHIVED_AT;
    return { id: sa.id, name: sa.name, archivedAt: sa.archivedAt };
  }

  async findServiceAccountByName(
    name: string,
  ): Promise<AnthropicServiceAccount | null> {
    this.enter("findServiceAccountByName", name);
    const sa = this.liveServiceAccounts().find((s) => s.name === name);
    return sa ? { id: sa.id, name: sa.name, archivedAt: null } : null;
  }

  async findFederationRuleByName(
    name: string,
  ): Promise<AnthropicFederationRule | null> {
    this.enter("findFederationRuleByName", name);
    const rule = this.liveRules().find((r) => r.name === name);
    return rule ? { id: rule.id, name: rule.name, archivedAt: null } : null;
  }

  private id(prefix: string): string {
    return `${prefix}_fake${this.nextId++}`;
  }

  private enter(op: AnthropicIdentityOperation, arg: unknown): void {
    this.calls.push({ op, arg });
    this.events.push(`anthropic.${op}`);
    const err = this.failures.get(op);
    if (err) {
      this.failures.delete(op);
      throw err;
    }
  }
}

// ─── Agent identity store fake ────────────────────────────────────────────────

const EMPTY_IDENTITY: AgentAnthropicIdentity = {
  ownerEmail: null,
  anthropicIdentityName: null,
  anthropicServiceAccountId: null,
  anthropicFederationRuleId: null,
  k8sServiceAccountName: null,
};

/**
 * In-memory stand-in for AgentAnthropicIdentityService (get/set) and
 * AnthropicIdentityNameAllocator (allocate). Names follow the real allocator's
 * pure naming rules.
 */
export class InMemoryAgentIdentityStore {
  readonly rows = new Map<string, AgentAnthropicIdentity>();
  private readonly setFailures = new Map<keyof AgentAnthropicIdentity, Error>();

  constructor(
    private readonly events: string[] = [],
    private readonly suffix?: string,
  ) {}

  addAgent(
    agentId: string,
    identity: Partial<AgentAnthropicIdentity> = {},
  ): void {
    this.rows.set(agentId, { ...EMPTY_IDENTITY, ...identity });
  }

  /** Make the next set() that writes `field` throw. */
  failNextSetOf(field: keyof AgentAnthropicIdentity, err?: Error): void {
    this.setFailures.set(field, err ?? new Error(`lost write of ${field}`));
  }

  async get(agentId: string): Promise<AgentAnthropicIdentity | null> {
    const row = this.rows.get(agentId);
    return row ? { ...row } : null;
  }

  async set(
    agentId: string,
    update: AgentAnthropicIdentityUpdate,
  ): Promise<AgentAnthropicIdentity> {
    const fields = (
      Object.keys(update) as (keyof AgentAnthropicIdentity)[]
    ).filter((k) => update[k] !== undefined);
    this.events.push(`store.set(${fields.join(",")})`);
    for (const field of fields) {
      const err = this.setFailures.get(field);
      if (err) {
        this.setFailures.delete(field);
        throw err;
      }
    }
    const row = this.rows.get(agentId);
    if (!row) throw new NotFoundError(`Agent ${agentId} not found`);
    for (const field of fields) row[field] = update[field] ?? null;
    return { ...row };
  }

  async allocate(agentId: string, ownerEmail: string): Promise<string> {
    this.events.push("store.allocate");
    const row = this.rows.get(agentId);
    if (!row) throw new NotFoundError(`Agent ${agentId} not found`);
    if (row.anthropicIdentityName) return row.anthropicIdentityName;
    const base = identityBaseName(ownerEmail, this.suffix);
    let n = 1;
    const taken = new Set(
      [...this.rows.values()].map((r) => r.anthropicIdentityName),
    );
    while (taken.has(identityName(base, n, this.suffix))) n++;
    row.anthropicIdentityName = identityName(base, n, this.suffix);
    return row.anthropicIdentityName;
  }
}

// ─── Kubernetes client wrapper ────────────────────────────────────────────────

/**
 * A KubernetesClient that forwards to a RecordedKubernetesClient, logs each
 * call as `k8s.<method>` and can fail any method once.
 */
export function faultyKubernetesClient(
  inner: RecordedKubernetesClient,
  events: string[] = [],
): KubernetesClient & {
  failNext(method: keyof KubernetesClient, err?: Error): void;
} {
  const failures = new Map<string, Error>();
  const failNext = (method: keyof KubernetesClient, err?: Error) => {
    failures.set(method, err ?? new Error(`k8s ${method} failed`));
  };
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "failNext") return failNext;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        events.push(`k8s.${String(prop)}`);
        const err = failures.get(String(prop));
        if (err) {
          failures.delete(String(prop));
          throw err;
        }
        return value.apply(target, args);
      };
    },
  }) as unknown as KubernetesClient & {
    failNext(method: keyof KubernetesClient, err?: Error): void;
  };
}
