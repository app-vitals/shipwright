/**
 * admin/src/platform-flags.unit.test.ts
 *
 * AGR-4.2: every platform feature @app-vitals/agent-admin adds over the
 * pre-swap in-repo admin is off in Shipwright's deployment. The chart sets
 * none of the flags by default (charts/shipwright/tests/
 * admin_platform_flags_off_test.yaml); this pins the other half of the
 * contract, that each flag is off when unset and on only for "enabled", so a
 * platform bump that renames a flag or flips a default fails here.
 */

import { describe, expect, it } from "bun:test";
import { parseAgentAskConfig } from "@app-vitals/agent-admin/agent-ask-config";
import { parseChatCredentialConfig } from "@app-vitals/agent-admin/chat-credential-config";
import { parseCronRunNowConfig } from "@app-vitals/agent-admin/cron-run-now-config";
import {
  DOC_ENABLED_ENV,
  isPlatformDocEnabled,
} from "@app-vitals/agent-admin/platform-doc-route";
import { parsePodServiceAccountConfig } from "@app-vitals/agent-admin/pod-service-account-config";
import { parseRepoAccessConfig } from "@app-vitals/agent-admin/repo-access-config";
import { parseTranscriptConfig } from "@app-vitals/agent-admin/transcript-config";

const FLAGS: ReadonlyArray<{
  feature: string;
  env: string;
  enabled: (env: Record<string, string | undefined>) => boolean;
}> = [
  {
    feature: "agent ask",
    env: "SHIPWRIGHT_AGENT_ASK_ENABLED",
    enabled: (env) => parseAgentAskConfig(env).enabled,
  },
  {
    feature: "chat credentials",
    env: "SHIPWRIGHT_CHAT_TOKEN_MINT_ENABLED",
    enabled: (env) => parseChatCredentialConfig(env).enabled,
  },
  {
    feature: "platform doc",
    env: DOC_ENABLED_ENV,
    enabled: (env) => isPlatformDocEnabled(env),
  },
  {
    feature: "cron-run transcripts",
    env: "SHIPWRIGHT_TRANSCRIPT_API_ENABLED",
    enabled: (env) => parseTranscriptConfig(env).enabled,
  },
  {
    feature: "cron run-now",
    env: "SHIPWRIGHT_CRON_RUN_NOW_ENABLED",
    enabled: (env) => parseCronRunNowConfig(env).enabled,
  },
  {
    feature: "repo-access check",
    env: "SHIPWRIGHT_AGENT_REPO_ACCESS_CHECK_ENABLED",
    enabled: (env) => parseRepoAccessConfig(env).enabled,
  },
  {
    feature: "pod ServiceAccount",
    env: "SHIPWRIGHT_K8S_AGENT_POD_SERVICE_ACCOUNT_ENABLED",
    enabled: (env) => parsePodServiceAccountConfig(env).enabled,
  },
];

describe("platform feature flags (AGR-4.2)", () => {
  it("the platform-doc flag keeps its name", () => {
    expect(DOC_ENABLED_ENV).toBe("SHIPWRIGHT_ADMIN_DOC_ENABLED");
  });

  for (const flag of FLAGS) {
    it(`${flag.feature}: off when ${flag.env} is unset`, () => {
      expect(flag.enabled({})).toBe(false);
    });

    it(`${flag.feature}: off for any value other than "enabled"`, () => {
      for (const value of ["", "true", "1", "on", "Enabled"]) {
        expect(flag.enabled({ [flag.env]: value })).toBe(false);
      }
    });

    it(`${flag.feature}: on only when ${flag.env}=enabled`, () => {
      expect(flag.enabled({ [flag.env]: "enabled" })).toBe(true);
    });
  }
});
