/**
 * agent/src/test-helpers/mock-deps.ts
 *
 * Shared ComposedAppDeps double for smoke tests.
 * After UNI-1.3, the composed app has no proxy — adminApiUrl and fetchFn
 * are no longer part of ComposedAppDeps.
 */

import type { ComposedAppDeps } from "../run-agent.ts";

export function makeMockDeps(): ComposedAppDeps {
  // No proxy deps needed — composed app only contains /chat (devChat-gated).
  return {};
}
