/**
 * admin/src/coding/admin-ui-coding.fixtures.ts
 * Test doubles for the coding extension's admin UI smoke tests: the platform
 * doubles from admin-ui.fixtures.ts plus the coding deps, and an app that
 * composes the platform admin UI with the coding extension's contributions
 * the way startAdmin() does (AEP-3.2).
 */

import { makeMockDeps } from "../admin-ui.fixtures.ts";
import { type AdminUIDeps, createAdminUIApp } from "../admin-ui.ts";
import {
  type CodingAgentDetailCardDeps,
  codingAgentDetailCards,
} from "./admin-ui-agent-cards.ts";

/** Platform admin UI deps plus every coding dep the tests override. */
export type CodingMockDeps = AdminUIDeps & Partial<CodingAgentDetailCardDeps>;

/** makeMockDeps() with the coding deps' overrides passed through. */
export function makeCodingMockDeps(
  overrides?: Partial<CodingMockDeps>,
): CodingMockDeps {
  return makeMockDeps(overrides as Parameters<typeof makeMockDeps>[0]);
}

/**
 * The platform admin UI with the coding extension's agent detail cards in its
 * slots, wired from the same deps.
 */
export function createCodingTestApp(deps: CodingMockDeps) {
  return createAdminUIApp({
    ...deps,
    agentDetailCards: codingAgentDetailCards({
      agentCronRunService: deps.agentCronRunService,
      agentPhaseMethodologyService: deps.agentPhaseMethodologyService,
      ...(deps.agentGitHubInstallationsService
        ? {
            agentGitHubInstallationsService:
              deps.agentGitHubInstallationsService,
          }
        : {}),
      ...(deps.fetchVerificationChecks
        ? { fetchVerificationChecks: deps.fetchVerificationChecks }
        : {}),
      ...(deps.fetchTaskStorePrs
        ? { fetchTaskStorePrs: deps.fetchTaskStorePrs }
        : {}),
    }),
  });
}
