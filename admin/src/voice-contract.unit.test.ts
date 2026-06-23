/**
 * admin/src/voice-contract.unit.test.ts
 *
 * Locks the voice WIRE CONTRACT at the admin layer — the env var NAMES the admin
 * provisioner stamps onto provisioned agent pods — and documents the Whisper
 * image ⇄ agent client contract so the two halves never drift.
 *
 * ── Whisper image vs agent client contract (CV-1.1) ─────────────────────────
 * The chart's `provider=whisper` pod runs `onerahmet/openai-whisper-asr-webservice`.
 * That image exposes a SINGLE ASR endpoint:
 *
 *     POST /asr?encode=true&task=transcribe&output=txt
 *
 * with the audio attached as the multipart field `audio_file`, returning the
 * transcription as a PLAIN-TEXT body (with output=txt) — NOT the OpenAI
 * `POST /v1/audio/transcriptions` JSON contract, and NOT a custom `/transcribe`
 * JSON endpoint. The agent's `makeWhisperSvcClient` (agent/src/voice.ts) targets
 * exactly that endpoint; the contract is exercised end-to-end in
 * agent/src/voice.unit.test.ts and agent/src/voice.integration.test.ts.
 *
 * The admin's only responsibility is to hand the agent the Whisper Service URL
 * under the agreed env var name `WHISPER_SERVICE_URL` (read in agent/src/config.ts).
 * This file pins that name — and the ElevenLabs/Groq names — against the manifest
 * builder so a rename on either side fails loudly here. No agent code is imported
 * (admin must not couple to the agent package); the assertion is against the wire
 * shape the admin emits.
 */

import { describe, expect, it } from "bun:test";
import {
  type AgentDeploymentOpts,
  buildAgentDeploymentManifest,
} from "./agent-manifest.ts";

const baseOpts: AgentDeploymentOpts = {
  agentId: "agent_42",
  namespace: "shipwright",
  image: "ghcr.io/app-vitals/shipwright-agent",
  imageTag: "v1.2.3",
  apiUrl: "http://shipwright-admin.shipwright.svc:3001",
  pvcName: "agent-42-home",
  secretName: "agent-42-token",
};

/** The exact env var the agent reads for the self-hosted Whisper Service URL. */
const WHISPER_SERVICE_URL_ENV = "WHISPER_SERVICE_URL";

describe("voice wire contract — env var names the admin stamps onto agent pods", () => {
  it("uses the env var name WHISPER_SERVICE_URL (onerahmet /asr service URL)", () => {
    const d = buildAgentDeploymentManifest({
      ...baseOpts,
      voice: { whisperServiceUrl: "http://r-shipwright-whisper:9000" },
    });
    const env = d.spec.template.spec.containers[0].env ?? [];
    const names = env.map((e) => e.name);

    // The agent's config.ts reads exactly this key; the onerahmet image is
    // reached at `${WHISPER_SERVICE_URL}/asr?...` by makeWhisperSvcClient.
    expect(names).toContain(WHISPER_SERVICE_URL_ENV);
    const whisper = env.find((e) => e.name === WHISPER_SERVICE_URL_ENV);
    expect(whisper?.value).toBe("http://r-shipwright-whisper:9000");
  });

  it("passes the Whisper URL as a plain value, never a secretKeyRef (the URL is not a secret)", () => {
    const d = buildAgentDeploymentManifest({
      ...baseOpts,
      voice: { whisperServiceUrl: "http://r-shipwright-whisper:9000" },
    });
    const whisper = (d.spec.template.spec.containers[0].env ?? []).find(
      (e) => e.name === WHISPER_SERVICE_URL_ENV,
    );
    expect(whisper?.value).toBeDefined();
    expect(whisper?.valueFrom).toBeUndefined();
  });

  it("uses the conventional third-party env var names for keys (ELEVENLABS_API_KEY, GROQ_API_KEY)", () => {
    const whisperMode = buildAgentDeploymentManifest({
      ...baseOpts,
      voice: {
        whisperServiceUrl: "http://w:9000",
        elevenLabsApiKey: "el",
      },
    });
    const whisperNames = (
      whisperMode.spec.template.spec.containers[0].env ?? []
    ).map((e) => e.name);
    expect(whisperNames).toContain("ELEVENLABS_API_KEY");
    // whisper STT never flows a Groq key
    expect(whisperNames).not.toContain("GROQ_API_KEY");

    const groqMode = buildAgentDeploymentManifest({
      ...baseOpts,
      voice: { groqApiKey: "g", elevenLabsApiKey: "el" },
    });
    const groqNames = (groqMode.spec.template.spec.containers[0].env ?? []).map(
      (e) => e.name,
    );
    expect(groqNames).toContain("GROQ_API_KEY");
    // groq STT never points at a self-hosted Whisper pod
    expect(groqNames).not.toContain(WHISPER_SERVICE_URL_ENV);
  });
});
