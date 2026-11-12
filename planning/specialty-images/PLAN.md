# PLAN: specialty-images

Session: `specialty-images` · Prefix: `SPI` · Planned: 2026-10-28
Origin: step 5 of the agent extraction plan (vitals-os per-specialty image selection). Requested by Dan.

Tasks span `app-vitals/agent`, `app-vitals/vitals-os` and `app-vitals/gitops` (`repo` is set per task).

## Problem

The admin provisioner takes one image and tag (`SHIPWRIGHT_AGENT_IMAGE` / `_IMAGE_TAG`, `KubernetesAgentProvisionerConfig.image/imageTag`) and applies it to every agent Deployment, including the reconcile pass that re-patches drifted Deployments. Prod pins that single image to `specialists-agent-vX.Y.Z` (`infra/helm/shipwright-deploy/values-prod.yaml`, `shipwright.agent.provisioning.image`). Every agent therefore runs the specialists-derived image, coding agents included. The specialists rebase onto the platform image (step 6) is gated on being able to run a different image per specialty.

`Agent.specialty` already exists (required, default `coding`) but `provision()` and `ReconcileTarget` do not carry it.

## Technical design

### Image selection is deploy config, not manifest

A per-specialty image map lives in deploy config: `SHIPWRIGHT_AGENT_IMAGES`, a JSON object `{ "<specialty>": { "repository": "...", "tag": "..." }, ... }`, rendered by the platform library chart from `agent.provisioning.images.<specialty>`.

- An image name is a deployment fact. The platform must not know registry paths, and one manifest must run on any deployment.
- Manifest delivery to the admin deployment is still an open question (see the specialists audit), so step 5 must not depend on it.
- It extends the existing `SHIPWRIGHT_AGENT_IMAGE` / `_TAG` pair. Those remain the default; an unmapped specialty falls back to them, and with no map set behavior is byte-for-byte what it is today.
- A manifest `image` field can be added later without rework.

### Provisioner (app-vitals/agent)

- `parseAgentImages(env)` in `admin-boot-config.ts` validates the JSON (strict: unknown shape is a boot error, not a silent fallback).
- `KubernetesAgentProvisionerConfig` gains `images?: Record<string, {image, imageTag}>`; a single `resolveImage(specialty)` is used by `deploymentManifestFor`, the drift check (`containerSpecDrifted`) and reconcile.
- `provision(agentId, opts)` and `ReconcileTarget` carry `specialty`; every caller (`agents.ts`, `agents-api.ts`, `startup-policy-reconcile.ts`, the reconcile loop) passes it.
- Docs: `docs/configuration-agent.md`, `docs/admin-service.md`.

### Library chart (app-vitals/agent)

`charts/agent-platform/templates/_admin.tpl` renders `SHIPWRIGHT_AGENT_IMAGES` from `agent.provisioning.images` only when non-empty. Render-parity (the chart-move check) must show an unchanged render when the key is unset. The Shipwright chart consumes the library, so it picks the change up with its next library bump; the dispatch chain already handles that.

### Coding image (app-vitals/vitals-os)

Coding agents need the `vitals-os` time-tracking plugin (it broke coding-agent time tracking when it was missing, which is why specialists bakes it). Chain: `agent -> shipwright -> vitals-os` (coding image). vitals-os builds a thin image `FROM ghcr.io/app-vitals/shipwright-agent:${BASE_TAG}`, baking its own canonical `plugins/vitals-os` under a marketplace named `vitals-os` at `/opt/shipwright/marketplaces/` (agents load it through a `vitals-os@vitals-os` AgentPlugin row, so the marketplace name must not change). It publishes to Artifact Registry, so the cluster pulls only from the registry it already uses. The one external pull is the public `shipwright-agent` base at build time, which the build verifies anonymously.

This is a return to the earlier `infra/vitals-agent` model (moved out in #6699), for the coding side only.

### Release chain

Today: shipwright `agent-v*` tag -> poller dispatches specialists `update-base-tag.yml` -> specialists builds -> PR re-pins `values-prod.yaml`. That lane stays for specialists (Bosun). Add a coding lane: the poller also dispatches a vitals-os base-tag bump, which builds the coding image and opens the `images.coding` pin PR. No Renovate auto-merge; the pin PR follows the same manual-merge rule as the specialists pin (a merge restarts every agent on that image).

### Deploy and rollback (gitops)

Shipwright is on Argo CD (AGM-4.3). A pin change is a vitals-os PR; `gitops-deploy.yml` then commits the new wrapper `targetRevision` to `app-vitals/gitops` `apps/shipwright.yaml`, Argo syncs, and the PostSync reconcile Job re-patches each agent Deployment to its resolved image. Rollback = `git revert` the pin (and the gitops commit); never `helm upgrade` by hand.

### Decisions

- **Specialties chain deferred to step 6** (Dan). Specialists keeps baking its own copy of the `vitals-os` plugin until it rebases onto the platform image; adding a vitals-os layer then avoids changing Bosun's image twice. SPI-3.4 adds a drift tripwire between the two plugin copies in the meantime (they already differ by version string: vitals-os 0.4.6, specialists 0.4.7).
- **`kubectl`** is baked only in the specialists image and used only by the chief-of-staff plugin. It stays there; whether it moves to the agent module or an add-on is parked as an open question, not a task.
- **Bosun** is the only non-coding agent. Its stored `specialty` must be confirmed before cutover: the column defaults to `coding`, so a mislabeled Bosun would move onto the bare coding image and lose its plugins (SPI-3.1).

## Tasks

| Task | Repo | Title | Depends on | HITL | Complexity | Model |
|---|---|---|---|---|---|---|
| SPI-1.1 | agent | feat: resolve the agent image per specialty in the provisioner | — | | 4 | sonnet |
| SPI-2.1 | agent | feat: render SHIPWRIGHT_AGENT_IMAGES from agent.provisioning.images | 1.1 | | 3 | sonnet |
| SPI-3.1 | vitals-os | chore: confirm Bosun's specialty and the coding agents' plugin rows | — | ⚠ | 2 | haiku |
| SPI-3.2 | vitals-os | feat: build the coding agent image from shipwright-agent plus the vitals-os plugin | — | | 4 | sonnet |
| SPI-3.3 | vitals-os | feat: add the coding-image release lane (base-tag bump, poller dispatch, pin PR) | 3.2 | | 4 | sonnet |
| SPI-3.4 | vitals-os | test: fail when the vitals-os plugin copies in vitals-os and specialists diverge | — | | 2 | haiku |
| SPI-4.1 | vitals-os | chore: pin coding agents to the coding image through images.coding | 2.1, 3.1, 3.3 | ⚠ | 3 | sonnet |
| SPI-5.1 | vitals-os | docs: describe per-specialty image selection and the coding image chain | 4.1 | | 2 | haiku |
| SPI-5.2 | gitops | docs: correct the shipwright deploy path and add the per-specialty image pins to the ops map | 4.1 | | 1 | haiku |

```
[START]
  ├─ SPI-1.1 provisioner ──── SPI-2.1 chart ─────────────┐
  ├─ SPI-3.1 ⚠ audit ────────────────────────────────────┤
  ├─ SPI-3.2 coding image ─── SPI-3.3 release lane ──────┴─ SPI-4.1 ⚠ cutover ─┬─ SPI-5.1
  └─ SPI-3.4 plugin drift test                                                  └─ SPI-5.2
```

## Breaking Change Safety

- The image map is additive; unset means unchanged. SPI-1.1 and SPI-2.1 are safe to deploy standalone.
- SPI-3.2/3.3/3.4 add new files and workflows; nothing consumes the coding image until SPI-4.1. Safe standalone.
- SPI-4.1 is the only behavior change: it moves coding pods to a new image. Add -> migrate -> remove is satisfied: the map (add), the image and lane (add), then the pin (migrate). Nothing is removed in this session; the specialists image keeps serving Bosun and the default.

## Cutover acceptance bar (SPI-4.1)

Per the 2026-10-27 decision on image swaps: the coding image is pullable by the cluster and verified (`kubectl run` smoke or a canary agent) before the pin lands, the AgentPlugin rows resolve against the baked marketplace, and rollback is a revert of the pin.
