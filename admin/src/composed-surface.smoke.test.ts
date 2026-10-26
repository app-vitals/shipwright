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
 *   - the "Signed commits" checkbox on the agent page of an agent with a
 *     GitHub App
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
      "POST /agents/{id}/repos": "1f8031e5aab46de1",
      "DELETE /agents/{id}/repos/{owner}/{name}": "b7ceaf0df1327d73",
      "POST /agents/{id}/chat-credentials": "ae7445d4d4fc44e7",
      "GET /agents/{id}/chat-credentials": "abba69c6c411961b",
      "DELETE /agents/{id}/chat-credentials/{tokenId}": "472b86e460db4f22",
      "POST /agents/{id}/ask": "8988d91e1a3fff5d",
      "GET /agents/{id}/asks": "95b107000180fdf0",
      "POST /agents/{id}/crons/{cronId}/run-now": "8dba50b4131e6cac",
      "PUT /agents/{id}/crons/{cronId}/runs/{runId}/transcript":
        "939307470867a15d",
      "GET /agents/{id}/crons/{cronId}/runs/{runId}/transcript":
        "8eab32b41a43f522",
    },
    removed: [],
    changed: {
      "PATCH /agents/{id}": "d97e5ce3e9c7ca26",
    },
  },
  schemas: {
    added: {
      AddAgentReposBody: "40d01eda5efac34d",
      CreateChatCredentialResponse: "f7d65d1fe7b9c6db",
      CreateChatCredentialBody: "0e225580dfba1ef2",
      ChatCredentialsWrapper: "67486ee890463357",
      ChatCredential: "e571a16ee620685d",
      AgentAskResponse: "be39e05090774785",
      AgentAskBody: "7daa4e1e3119a719",
      AgentAskList: "66411bd74ada15c3",
      AgentAskRecord: "f470e4b5a7c29738",
      CronRunNowResponse: "573587ce13f06f60",
      CronRunTranscriptUploadResult: "4a1283819cff255f",
      UploadCronRunTranscriptBody: "fb2d6c0c8f6ee427",
      CronRunTranscript: "f601d1c19563cc32",
      AgentConfigFeatures: "f28be53dfab28eb3",
    },
    removed: [],
    changed: {
      AgentCronJob: "65941cea117e0c88",
      AgentConfigResponse: "4c3abf6fea0cc33c",
    },
  },
  pages: {
    added: {},
    removed: [],
    changed: {
      "agent detail (GitHub App)": "pending",
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
