/**
 * admin/src/composed-surface.smoke.test.ts
 *
 * Pins the composed admin surface (AGR-4.2). Shipwright's admin is the
 * platform admin from @app-vitals/agent-admin plus the coding extension. The
 * composed OpenAPI document and the rendered admin pages may differ from the
 * pre-swap in-repo admin (fixtures/composed-surface.baseline.json) ONLY by
 * the platform additions accepted with the swap:
 *
 *   - repos add/remove routes (POST /agents/{id}/repos,
 *     DELETE /agents/{id}/repos/{owner}/{name}) and the PATCH /agents/{id}
 *     description pointing at them
 *   - chat-credential mint/list/revoke routes (flag
 *     SHIPWRIGHT_CHAT_TOKEN_MINT_ENABLED; 404 when off)
 *   - agent ask routes (flag SHIPWRIGHT_AGENT_ASK_ENABLED)
 *   - cron run-now route and AgentCronJob.runRequestedAt (flag
 *     SHIPWRIGHT_CRON_RUN_NOW_ENABLED)
 *   - cron-run transcript upload/read routes and the config bundle's
 *     `features` block (flag SHIPWRIGHT_TRANSCRIPT_API_ENABLED)
 *   - the per-repo access probe result on the GitHub installations
 *     snapshot (RepoAccessEntry, `repoAccess` on the snapshot, `repos` on
 *     its PUT body; the runtime reports it only when the config bundle's
 *     `features.repoAccessCheck` is on, flag
 *     SHIPWRIGHT_AGENT_REPO_ACCESS_CHECK_ENABLED) — added in 0.5.0
 *   - the "Signed commits" checkbox on the agent page of an agent with a
 *     GitHub App (SHIPWRIGHT_SIGNED_COMMITS env row; no flag), and one
 *     blank line in its place on every other agent page
 *
 * The platform-doc route (GET /doc, flag SHIPWRIGHT_ADMIN_DOC_ENABLED) and the
 * per-agent pod ServiceAccount (flag
 * SHIPWRIGHT_K8S_AGENT_POD_SERVICE_ACCOUNT_ENABLED) do not appear in the
 * composed document or the rendered pages.
 *
 * Any other change fails here. When a platform bump changes the surface on
 * purpose, update EXPECTED_DIFF from the failure output and record why.
 */

import { describe, expect, it } from "bun:test";
import {
  type ComposedSurface,
  diffRecords,
  fingerprintComposedSurface,
  type SurfaceDiff,
} from "./composed-surface.fixtures.ts";
import baseline from "./fixtures/composed-surface.baseline.json";

const EXPECTED_DIFF: {
  operations: SurfaceDiff;
  schemas: SurfaceDiff;
  pages: SurfaceDiff;
} = {
  operations: {
    added: {
      "POST /agents/{id}/repos": "sha256:1f8031e5aab46de1",
      "DELETE /agents/{id}/repos/{owner}/{name}": "sha256:b7ceaf0df1327d73",
      "POST /agents/{id}/chat-credentials": "sha256:ae7445d4d4fc44e7",
      "GET /agents/{id}/chat-credentials": "sha256:abba69c6c411961b",
      "DELETE /agents/{id}/chat-credentials/{tokenId}":
        "sha256:472b86e460db4f22",
      "POST /agents/{id}/ask": "sha256:8988d91e1a3fff5d",
      "GET /agents/{id}/asks": "sha256:95b107000180fdf0",
      "POST /agents/{id}/crons/{cronId}/run-now": "sha256:8dba50b4131e6cac",
      "PUT /agents/{id}/crons/{cronId}/runs/{runId}/transcript":
        "sha256:939307470867a15d",
      "GET /agents/{id}/crons/{cronId}/runs/{runId}/transcript":
        "sha256:8eab32b41a43f522",
    },
    removed: [],
    changed: {
      "PATCH /agents/{id}": "sha256:d97e5ce3e9c7ca26",
    },
  },
  schemas: {
    added: {
      AddAgentReposBody: "sha256:40d01eda5efac34d",
      CreateChatCredentialResponse: "sha256:f7d65d1fe7b9c6db",
      CreateChatCredentialBody: "sha256:0e225580dfba1ef2",
      ChatCredentialsWrapper: "sha256:67486ee890463357",
      ChatCredential: "sha256:e571a16ee620685d",
      AgentAskResponse: "sha256:be39e05090774785",
      AgentAskBody: "sha256:7daa4e1e3119a719",
      AgentAskList: "sha256:66411bd74ada15c3",
      AgentAskRecord: "sha256:f470e4b5a7c29738",
      CronRunNowResponse: "sha256:573587ce13f06f60",
      CronRunTranscriptUploadResult: "sha256:4a1283819cff255f",
      RepoAccessEntry: "sha256:e42976826762413d",
      UploadCronRunTranscriptBody: "sha256:fb2d6c0c8f6ee427",
      CronRunTranscript: "sha256:f601d1c19563cc32",
      AgentConfigFeatures: "sha256:f28be53dfab28eb3",
    },
    removed: [],
    changed: {
      AgentCronJob: "sha256:65941cea117e0c88",
      AgentGitHubInstallationsSnapshot: "sha256:077baac77418053c",
      PutGitHubInstallationsBody: "sha256:902b6963f090cc52",
      AgentConfigResponse: "sha256:4c3abf6fea0cc33c",
    },
  },
  pages: {
    added: {},
    removed: [],
    changed: {
      // One blank line where the (hidden) signed-commits box renders.
      "agent detail": "200 sha256:f4b7cbeb503eb2ba",
      // The "Signed commits" checkbox, shown only with GH_APP_ID set.
      "agent detail (GitHub App)": "200 sha256:1d9f68995fc9e2b4",
    },
  },
};

describe("composed admin surface vs the pre-swap baseline (AGR-4.2)", async () => {
  const before = baseline as ComposedSurface;
  const after = await fingerprintComposedSurface();

  it("composed OpenAPI operations differ only by the pinned platform additions", () => {
    expect(diffRecords(before.operations, after.operations)).toEqual(
      EXPECTED_DIFF.operations,
    );
  });

  it("composed OpenAPI schemas differ only by the pinned platform additions", () => {
    expect(diffRecords(before.schemas, after.schemas)).toEqual(
      EXPECTED_DIFF.schemas,
    );
  });

  it("the rest of the composed OpenAPI document is unchanged", () => {
    expect(after.document).toBe(before.document);
  });

  it("rendered admin pages differ only by the pinned platform additions", () => {
    expect(diffRecords(before.pages, after.pages)).toEqual(EXPECTED_DIFF.pages);
  });
});
