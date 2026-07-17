/**
 * Tests for agent/src/piper-voice.ts
 *
 * Strategy: inject a fake readdirFn — no real filesystem I/O (agent/src test
 * isolation rule). Spy on console.warn/console.error by swapping the bound
 * method on the console object itself (not a global override) and restoring
 * it after each assertion.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_PIPER_VOICE,
  VOICES_DIR,
  resolvePiperVoicePaths,
  validatePiperVoice,
} from "./piper-voice.ts";

let warnCalls: unknown[][] = [];
let errorCalls: unknown[][] = [];
let originalWarn: typeof console.warn;
let originalError: typeof console.error;

beforeEach(() => {
  warnCalls = [];
  errorCalls = [];
  originalWarn = console.warn;
  originalError = console.error;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
  console.error = (...args: unknown[]) => {
    errorCalls.push(args);
  };
});

afterEach(() => {
  console.warn = originalWarn;
  console.error = originalError;
});

const makeReaddirFn = (files: string[]) => (_dir: string) => files;

describe("validatePiperVoice", () => {
  test("defaults to en_US-hfc_female-medium when PIPER_VOICE is unset", () => {
    const readdirFn = makeReaddirFn([
      "en_US-hfc_female-medium.onnx",
      "en_US-hfc_female-medium.onnx.json",
    ]);
    const result = validatePiperVoice(undefined, readdirFn);
    expect(result).toBe(DEFAULT_PIPER_VOICE);
    expect(result).toBe("en_US-hfc_female-medium");
  });

  test("returns the requested voice when present in the discovered directory listing", () => {
    const readdirFn = makeReaddirFn([
      "en_US-hfc_female-medium.onnx",
      "en_US-hfc_female-medium.onnx.json",
      "en_GB-alan-medium.onnx",
      "en_GB-alan-medium.onnx.json",
    ]);
    const result = validatePiperVoice("en_GB-alan-medium", readdirFn);
    expect(result).toBe("en_GB-alan-medium");
    // No warnings/errors on a hit.
    expect(warnCalls.length).toBe(0);
    expect(errorCalls.length).toBe(0);
  });

  test("falls back and logs loudly when the requested voice is not discovered", () => {
    const readdirFn = makeReaddirFn([
      "en_US-hfc_female-medium.onnx",
      "en_US-hfc_female-medium.onnx.json",
      "en_GB-alan-medium.onnx",
      "en_GB-alan-medium.onnx.json",
    ]);
    const result = validatePiperVoice("nonexistent-voice", readdirFn);

    // Process must not crash — a usable voice name is returned.
    expect(typeof result).toBe("string");

    const logged = [...warnCalls, ...errorCalls];
    expect(logged.length).toBeGreaterThan(0);
    const allLoggedText = logged.map((call) => call.join(" ")).join("\n");
    expect(allLoggedText).toContain("nonexistent-voice");
    expect(allLoggedText).toContain("en_US-hfc_female-medium");
    expect(allLoggedText).toContain("en_GB-alan-medium");
  });

  test("does not throw when the directory scan fails (readdirFn throws)", () => {
    const throwingReaddirFn = (_dir: string): string[] => {
      throw new Error("ENOENT: no such directory");
    };
    expect(() =>
      validatePiperVoice("en_US-hfc_female-medium", throwingReaddirFn),
    ).not.toThrow();
  });

  test("uses the hardcoded VOICES_DIR constant, not an env-configurable path", () => {
    let receivedDir: string | undefined;
    const readdirFn = (dir: string) => {
      receivedDir = dir;
      return ["en_US-hfc_female-medium.onnx"];
    };
    validatePiperVoice(undefined, readdirFn);
    expect(receivedDir).toBe(VOICES_DIR);
    expect(VOICES_DIR).toBe("/app/agent/voices/");
  });
});

describe("resolvePiperVoicePaths", () => {
  test("returns the .onnx/.onnx.json pair path for a voice name", () => {
    const { onnxPath, onnxJsonPath } = resolvePiperVoicePaths(
      "en_US-hfc_female-medium",
    );
    expect(onnxPath).toBe(`${VOICES_DIR}en_US-hfc_female-medium.onnx`);
    expect(onnxJsonPath).toBe(`${VOICES_DIR}en_US-hfc_female-medium.onnx.json`);
  });

  test("resolves paths for a different voice name", () => {
    const { onnxPath, onnxJsonPath } =
      resolvePiperVoicePaths("en_GB-alan-medium");
    expect(onnxPath).toBe(`${VOICES_DIR}en_GB-alan-medium.onnx`);
    expect(onnxJsonPath).toBe(`${VOICES_DIR}en_GB-alan-medium.onnx.json`);
  });
});
