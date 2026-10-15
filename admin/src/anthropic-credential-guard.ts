/**
 * admin/src/anthropic-credential-guard.ts
 * Shared guard for Anthropic workload identity federation (WIF-2.1).
 *
 * CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN each
 * outrank federation in the Anthropic client — even set to an empty string —
 * so with federation enabled none of them may reach a federated (non
 * self-hosted) agent through its env bundle.
 */

import { BadRequestError } from "./errors.ts";

export const ANTHROPIC_CREDENTIAL_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

/** Stable machine-readable code for API/UI callers. */
export const ANTHROPIC_CREDENTIALS_BLOCKED_CODE =
  "anthropic_credentials_blocked_federation";

const BLOCKED_KEYS = new Set<string>(ANTHROPIC_CREDENTIAL_KEYS);

export function isAnthropicCredentialKey(key: string): boolean {
  return BLOCKED_KEYS.has(key);
}

/** The subset of `keys` that are blocked Anthropic credential keys. */
export function anthropicCredentialKeysIn(keys: Iterable<string>): string[] {
  return [...keys].filter(isAnthropicCredentialKey);
}

/** Thrown (HTTP 400) when a blocked key is written for a federated agent. */
export class AnthropicCredentialsBlockedError extends BadRequestError {
  readonly code = ANTHROPIC_CREDENTIALS_BLOCKED_CODE;

  constructor(public readonly keys: string[]) {
    super(
      `${ANTHROPIC_CREDENTIALS_BLOCKED_CODE}: ${keys.join(", ")} cannot be set on an agent that uses Anthropic workload identity federation`,
    );
    this.name = "AnthropicCredentialsBlockedError";
  }
}
