/**
 * Generic user display name resolver with in-memory cache.
 *
 * Uses a structural UserResolverClient interface instead of importing
 * @slack/web-api directly — keeping the agent package Slack-agnostic.
 */

// In-memory cache — survives for the lifetime of the process.
// Export clearCache() for test teardown to prevent cross-test leakage
// when Bun shares the module between test files.
const cache = new Map<string, string>();

/** Clear the in-memory display name cache. Use in test afterEach teardown. */
export function clearCache(): void {
  cache.clear();
}

export interface UserResolverClient {
  users: {
    info(args: { user: string }): Promise<{
      user?: {
        profile?: { display_name?: string; real_name?: string };
        name?: string;
      };
    }>;
  };
}

export async function resolveDisplayName(
  userId: string,
  client: UserResolverClient,
): Promise<string> {
  const cached = cache.get(userId);
  if (cached !== undefined) return cached;

  try {
    const res = await client.users.info({ user: userId });
    const name =
      res.user?.profile?.display_name ||
      res.user?.profile?.real_name ||
      res.user?.name ||
      userId;
    cache.set(userId, name);
    return name;
  } catch (err) {
    console.warn(
      `[users] failed to resolve display name for ${userId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return userId;
  }
}
