# Plan: voice-note-mime-fix

Repo: app-vitals/shipwright

## Problem

Recording a voice note in the admin chat from a laptop or mobile browser records
fine but the upload fails with `Attachment type "video/webm" is not allowed`.

Root cause: the mic handler in `admin/src/admin-ui-pages.ts` builds the uploaded
`File` type from `mediaRecorder.mimeType`. Chromium often reports
`video/webm;codecs=opus` for audio-only streams, and mobile Safari records
`audio/mp4`. The allowlist in `admin/src/attachment-validation.ts` only has
`audio/webm`, `audio/webm;codecs=opus` and `audio/ogg`, so `validateAttachment`
(called from `admin-ui.ts`) returns 415. The chat service does no MIME check.

## Design (all in `admin/`)

**Client (`admin-ui-pages.ts`)**
- Add `audio/mp4` to `MIC_MIME_CANDIDATES` so Safari records a supported type.
- Normalize the blob type to `audio/*` before building the `File`
  (`video/webm;codecs=opus` -> `audio/webm`).
- Use `.m4a` for mp4 recordings; keep `.ogg` / `.webm` otherwise.

**Validation (`attachment-validation.ts`)**
- Strip MIME parameters and lowercase before the allowlist lookup.
- Allow `audio/mp4`, `audio/mpeg`, `audio/wav`.
- Accept `video/webm` only when the filename ends in `.webm` (safety net for
  clients still running the cached old script).

**Playback**
- Add `.m4a` to `AUDIO_FILE_EXTENSIONS` and map it to `audio/mp4` in
  `AUDIO_CONTENT_TYPES` so the attachment proxy serves inline audio.

Rationale for doing both client and server: client-only leaves cached pages
broken; server-only stores mislabeled types.

## Tasks

| Task | Title | Layer | Hours | Complexity | Model | Deps | HITL |
|---|---|---|---|---|---|---|---|
| VMF-1.1 | Accept Chromium/Safari mic-recording MIME types for voice notes | Frontend | 2 | 3 | sonnet | none | no |

Branch: `feat/vmf-1-1-accept-mic-recording-mime`

Safe to deploy standalone: yes (additions only; no renames or removals).

## Dependency Map

```
[START]
  └─ VMF-1.1 (no deps)
```
