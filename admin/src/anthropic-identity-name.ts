/**
 * admin/src/anthropic-identity-name.ts
 * Anthropic identity name allocator (PAI-1.3). Names are built from the
 * owner's email: jane.doe@example.com becomes jane-doe, then -a{n} with the
 * next free number for that owner, then an optional per-environment suffix.
 * Names match ^[a-z0-9-]+$, are at most 255 characters, and are unique
 * (Agent.anthropicIdentityName unique index).
 */

import type { PrismaClient } from "../prisma/client/client.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";

export const MAX_IDENTITY_NAME_LENGTH = 255;

const NAME_PATTERN = /^[a-z0-9-]+$/;
const MAX_N_DIGITS = 10;
const MAX_N = 10 ** MAX_N_DIGITS - 1;
/** Maximum unique-conflict retries before giving up. */
const MAX_ATTEMPTS = 10;

function normalizeSuffix(suffix: string | undefined): string {
  if (suffix === undefined || suffix === "") return "";
  if (!NAME_PATTERN.test(suffix)) {
    throw new BadRequestError(
      "Anthropic identity name suffix must match ^[a-z0-9-]+$",
    );
  }
  return suffix;
}

/** Length of everything the name needs besides the base: -a{n}[-suffix]. */
function reservedLength(suffix: string): number {
  return "-a".length + MAX_N_DIGITS + (suffix ? `-${suffix}`.length : 0);
}

/**
 * Base name from an owner email: local part (before the last @) without a
 * +tag, lowercased, anything outside [a-z0-9] mapped to `-`, repeated `-`
 * collapsed and ends trimmed. Truncated (independently of n) so that
 * `identityName(base, n, suffix)` always fits in 255 characters.
 * @throws BadRequestError for a malformed email, an empty result or a bad suffix
 */
export function identityBaseName(email: string, suffix?: string): string {
  const sfx = normalizeSuffix(suffix);
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) {
    throw new BadRequestError("Owner email is malformed");
  }
  const maxBase = MAX_IDENTITY_NAME_LENGTH - reservedLength(sfx);
  if (maxBase < 1) {
    throw new BadRequestError("Anthropic identity name suffix is too long");
  }
  const local = (email.slice(0, at).split("+")[0] ?? "").toLowerCase();
  const base = local
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, maxBase)
    .replace(/-+$/, "");
  if (!base) {
    throw new BadRequestError("Owner email has no usable local part");
  }
  return base;
}

/**
 * `${base}-a${n}` plus `-${suffix}` when given.
 * @throws BadRequestError if n, base or suffix is invalid or the name is too long
 */
export function identityName(base: string, n: number, suffix?: string): string {
  const sfx = normalizeSuffix(suffix);
  if (!Number.isInteger(n) || n < 1 || n > MAX_N) {
    throw new BadRequestError("Identity number must be a positive integer");
  }
  const name = `${base}-a${n}${sfx ? `-${sfx}` : ""}`;
  if (!NAME_PATTERN.test(name) || name.length > MAX_IDENTITY_NAME_LENGTH) {
    throw new BadRequestError("Invalid Anthropic identity name");
  }
  return name;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prismaCode(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

export interface AnthropicIdentityNameAllocatorOptions {
  /** Per-environment suffix appended to every allocated name. */
  suffix?: string | undefined;
}

export class AnthropicIdentityNameAllocator {
  private readonly suffix: string;

  constructor(
    private prisma: PrismaClient,
    options: AnthropicIdentityNameAllocatorOptions = {},
  ) {
    this.suffix = normalizeSuffix(options.suffix);
  }

  /**
   * Allocate the next free `-a{n}` name for the owner and save it on the
   * agent. Idempotent: an agent that already has a name keeps it.
   * Concurrent allocations are serialized by the unique index — the loser
   * of a race rescans and retries with the next number.
   * @throws NotFoundError if the agent does not exist
   * @throws BadRequestError if the email is malformed
   * @throws ConflictError if retries are exhausted
   */
  async allocate(agentId: string, ownerEmail: string): Promise<string> {
    const base = identityBaseName(ownerEmail, this.suffix);
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { anthropicIdentityName: true },
    });
    if (!agent) throw new NotFoundError(`Agent ${agentId} not found`);
    if (agent.anthropicIdentityName) return agent.anthropicIdentityName;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const name = identityName(base, await this.nextNumber(base), this.suffix);
      try {
        // Only write while the agent has no name, so a concurrent allocate
        // for the same agent cannot overwrite a name that is already taken.
        const { count } = await this.prisma.agent.updateMany({
          where: { id: agentId, anthropicIdentityName: null },
          data: { anthropicIdentityName: name },
        });
        if (count === 1) return name;
      } catch (err) {
        if (prismaCode(err) !== "P2002") throw err;
        continue;
      }
      const current = await this.prisma.agent.findUnique({
        where: { id: agentId },
        select: { anthropicIdentityName: true },
      });
      if (!current) throw new NotFoundError(`Agent ${agentId} not found`);
      if (current.anthropicIdentityName) return current.anthropicIdentityName;
    }
    throw new ConflictError("Could not allocate a unique identity name");
  }

  /** max(n) + 1 over this owner's existing names (1 if none). */
  private async nextNumber(base: string): Promise<number> {
    const rows = await this.prisma.agent.findMany({
      where: { anthropicIdentityName: { startsWith: `${base}-a` } },
      select: { anthropicIdentityName: true },
    });
    const sfx = this.suffix ? `-${escapeRegExp(this.suffix)}` : "";
    const pattern = new RegExp(
      `^${escapeRegExp(base)}-a([1-9][0-9]{0,${MAX_N_DIGITS - 1}})${sfx}$`,
    );
    let max = 0;
    for (const row of rows) {
      const m = pattern.exec(row.anthropicIdentityName ?? "");
      if (m?.[1]) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  }
}
