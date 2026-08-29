/**
 * admin/src/attachment-validation.unit.test.ts
 *
 * Unit tests for pure attachment validation logic — no I/O.
 */

import { describe, expect, it } from "bun:test";
import {
  MAX_ATTACHMENT_BYTES,
  validateAttachment,
} from "./attachment-validation.ts";

describe("validateAttachment", () => {
  it("accepts a text/plain file under 10 MB", () => {
    const result = validateAttachment("notes.txt", 1024, "text/plain");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filename).toBe("notes.txt");
      expect(result.size).toBe(1024);
    }
  });

  it("accepts an image/png under the limit", () => {
    const result = validateAttachment("pic.png", 500_000, "image/png");
    expect(result.ok).toBe(true);
  });

  it("accepts an application/pdf file", () => {
    const result = validateAttachment("doc.pdf", 2_000_000, "application/pdf");
    expect(result.ok).toBe(true);
  });

  it("accepts a file exactly at the size limit", () => {
    const result = validateAttachment(
      "big.txt",
      MAX_ATTACHMENT_BYTES,
      "text/plain",
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a file over 10 MB with status 413", () => {
    const result = validateAttachment(
      "huge.txt",
      MAX_ATTACHMENT_BYTES + 1,
      "text/plain",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(413);
      expect(result.error).toBeTruthy();
    }
  });

  it("rejects a disallowed MIME type like video/mp4 with status 415", () => {
    const result = validateAttachment("clip.mp4", 1024, "video/mp4");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(415);
      expect(result.error).toBeTruthy();
    }
  });

  it("rejects application/x-executable with status 415", () => {
    const result = validateAttachment(
      "run.bin",
      1024,
      "application/x-executable",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(415);
    }
  });

  // CFB-3.1: picking an *existing* photo from an iPhone photo library (not the
  // camera) can hand the browser a HEIC/HEIF file — these were previously
  // missing from the allowlist and got a hard 415 rejection.
  it("accepts an image/heic file under the limit", () => {
    const result = validateAttachment("photo.heic", 2_000_000, "image/heic");
    expect(result.ok).toBe(true);
  });

  it("accepts an image/heif file under the limit", () => {
    const result = validateAttachment("photo.heif", 2_000_000, "image/heif");
    expect(result.ok).toBe(true);
  });

  it("rejects application/octet-stream with status 415", () => {
    const result = validateAttachment(
      "unknown.bin",
      1024,
      "application/octet-stream",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(415);
    }
  });

  it("rejects an empty-string MIME type with status 415", () => {
    const result = validateAttachment("unknown", 1024, "");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(415);
    }
  });
});
