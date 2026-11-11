# Platform manifest (moved)

The agent platform (runtime, admin, shared lib, and the neutral default specialty) was extracted into [app-vitals/agent](https://github.com/app-vitals/agent) (AGR program, completed by AGR-4.4). The copy-paste-readiness gate that this page described (`platform-manifest.json` plus `scripts/platform-gate.ts`) moved there with the code and runs in that repository's CI. Shipwright no longer carries the manifest, the gate, or the pre-cutover freeze guard.

Shipwright consumes the platform as pinned registry packages and an image:

- `@app-vitals/agent-runtime`, `@app-vitals/agent-admin` and `@app-vitals/agent-lib`, pinned exactly in the workspace `package.json` files.
- `ghcr.io/app-vitals/agent`, the base of `agent/Dockerfile` (`ARG PLATFORM_VERSION`).

A platform release reaches Shipwright through `.github/workflows/platform-release.yml` (the `platform-release` repository dispatch, with Renovate as a fallback), which opens a bump PR re-pinning all of the above. See [Local cross-repo development](./local-platform-development.md) for working on the platform and Shipwright together, and the read-only [platform docs snapshot](./platform/agent.md) for the platform reference.

Design history: `planning/agent-repo-extraction/PLAN.md`.
