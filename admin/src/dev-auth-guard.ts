/**
 * admin/src/dev-auth-guard.ts
 *
 * Guard for the dev auto-login route (/admin/dev-login).
 *
 * The dev-login endpoint is an unauthenticated local convenience and must never
 * be reachable in a production deployment. This module exposes a PURE predicate
 * over an injected env object (deterministically unit-testable, no process.env
 * reads). Production is hard-blocked regardless of the ADMIN_DEV_AUTH flag.
 */

export interface DevAuthGuardEnv {
  ADMIN_DEV_AUTH?: string;
  NODE_ENV?: string;
}

/**
 * Returns true iff dev auto-login is allowed.
 *
 * Allowed iff:
 *   - NODE_ENV !== "production"   (hard block in prod, ignores ADMIN_DEV_AUTH)
 *   - ADMIN_DEV_AUTH === "true"
 */
export function isDevAuthAllowed(env: DevAuthGuardEnv): boolean {
  if (env.NODE_ENV === "production") {
    return false;
  }
  return env.ADMIN_DEV_AUTH === "true";
}
