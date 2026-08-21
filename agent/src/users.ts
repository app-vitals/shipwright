/**
 * Generic user display name / email resolver with in-memory cache.
 *
 * Uses a structural UserResolverClient interface instead of importing
 * @slack/web-api directly — keeping the agent package Slack-agnostic.
 *
 * A single users.info() call is cached per user id and used to serve both
 * the display name and the email, avoiding a second API call when a caller
 * needs both.
 */

interface ResolvedUser {
  name: string;
  email?: string;
}

// In-memory cache — survives for the lifetime of the process.
// Export clearCache() for test teardown to prevent cross-test leakage
// when Bun shares the module between test files.
const cache = new Map<string, ResolvedUser>();

/** Clear the in-memory display name / email cache. Use in test afterEach teardown. */
export function clearCache(): void {
  cache.clear();
}

export interface UserResolverClient {
  users: {
    info(args: { user: string }): Promise<{
      user?: {
        profile?: {
          display_name?: string;
          real_name?: string;
          email?: string;
        };
        name?: string;
      };
    }>;
  };
}

async function resolveUser(
  userId: string,
  client: UserResolverClient,
): Promise<ResolvedUser> {
  const cached = cache.get(userId);
  if (cached !== undefined) return cached;

  try {
    const res = await client.users.info({ user: userId });
    const resolved: ResolvedUser = {
      name:
        res.user?.profile?.display_name ||
        res.user?.profile?.real_name ||
        res.user?.name ||
        userId,
      email: res.user?.profile?.email || undefined,
    };
    cache.set(userId, resolved);
    return resolved;
  } catch (err) {
    console.warn(
      `[users] failed to resolve user ${userId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { name: userId, email: undefined };
  }
}

export async function resolveDisplayName(
  userId: string,
  client: UserResolverClient,
): Promise<string> {
  const { name } = await resolveUser(userId, client);
  return name;
}

/**
 * Resolve the Slack user's email from the same cached users.info() lookup
 * used by resolveDisplayName. Returns undefined if the email is absent —
 * e.g. the users:read.email scope hasn't been granted yet, or the user
 * genuinely has no email on file — never throws.
 */
export async function resolveUserEmail(
  userId: string,
  client: UserResolverClient,
): Promise<string | undefined> {
  const { email } = await resolveUser(userId, client);
  return email;
}
