# Plan: move the platform half of the shipwright Helm chart into app-vitals/agent

**Session**: `chart-move` · **Prefix**: `CHM` · **Repos**: `app-vitals/shipwright`, `app-vitals/agent`, `app-vitals/vitals-os` (CHM-4.1 only)
**Context**: `agent-extraction-plan.md` (workspace), [`../chat-extraction/PLAN.md`](../chat-extraction/PLAN.md), [`../agent-repo-extraction/PLAN.md`](../agent-repo-extraction/PLAN.md)

Approved interactively by Dan McAulay on 2026-10-27.

## Start state

One Helm chart, `shipwright` (1.29.9), in this repo deploys admin, task-store, metrics, mcp-server, chat, whisper and agent-provisioning RBAC, plus ingress/gateway, cert-manager bootstrap and an optional Postgres. It is published to GitHub Pages (`app-vitals.github.io/shipwright`) and consumed by the private `shipwright-deploy` wrapper in vitals-os, which Argo CD deploys with `prune: true` and `selfHeal: true` (gitops `apps/shipwright.yaml`, release `shipwright`). `app-vitals/agent` holds the platform code and images but no chart, so the platform cannot be deployed from its own repo.

The platform and coding templates are interleaved in the shared files (httproute, healthcheckpolicy, tenant-networkpolicy, postgres initdb and db-bootstrap, NOTES): a file-level split does not exist.

## Prod facts (baseline captured 2026-10-27, kept privately, CHM-1.1)

- 34 Argo-managed objects across namespaces `shipwright` and `vitals-os` plus cluster RBAC. Every name is `shipwright-*`; anything that renders under a different name is pruned.
- No PVCs in `shipwright`; no bundled Postgres. All persistent data is in a shared Cloud SQL instance: admin, task-store and chat databases only. The agent home PVCs in `vitals-os` are created by the admin at runtime, not by Helm.
- All Deployment secretKeyRefs use `shipwright-secrets` (SecretSync + a SecretProviderClass that comes from the wrapper, not this chart). `shipwright-admin/metrics/voice` Secrets are empty shells; `shipwright-internal` is outside the chart.
- vitals-os reaches chat through an ExternalName alias to `shipwright-chat.shipwright.svc`.

## Design

- **Library chart, not subchart, not a file split.** The platform templates become named templates in a library chart `agent-platform`, published from `app-vitals/agent`. The deployable chart stays here as `shipwright` with the same name, release name and values keys; its platform template files become one-line includes. A library shares the parent's values context, so nothing nests under a subchart key and vitals-os's `values-prod.yaml` does not change. A subchart would force a prod values migration and derive resource names from its own chart name.
- **Zero-rename is the data-safety gate.** CHM-1.2 builds a render-parity tool (normalizing only the `helm.sh/chart` label) and a CI check; every switch task must show zero diff across all `ci/` and `examples/` values. CHM-4.1 repeats it against the real prod values and the private golden names list before the flip.
- **Add, switch, flip.** All CHM-2.x work is additive in the agent repo. Shipwright switches area by area (CHM-3.x), each gated on parity. Prod only changes in CHM-4.1, a pin bump in the wrapper, reverted with `git revert` in gitops (Helm release records v2584..v2593 remain a second path).
- **Distribution follows the existing pattern.** Published charts of ours go to GitHub Pages (`chart-release.yml` pattern); internal charts are pinned by git SHA in gitops; OCI is only used for third-party charts. The library is published to `app-vitals.github.io/agent` and must resolve anonymously (CHM-2.2) before anything depends on it. The agent repo is public, so Pages needs no credentials.
- **Release chain.** The deployable chart's publish, auto-bump, drift check and the vitals-os polling flow stay where they are. The only new link is: a library release dispatches to Shipwright, which bumps its pin (CHM-2.7, CHM-3.5), with a drift check that fails loudly on a stale pin.
- **Shared templates use extension lists.** CHM-2.6 gives the library mechanisms for routes, health checks, network-policy rules and databases; Shipwright supplies the task-store/metrics/mcp-server entries (CHM-3.4).

## Decisions (Dan, 2026-10-27)

- Move the chart as a library chart; keep the deployable chart's name, release and values keys.
- Publish via GitHub Pages, matching current patterns.
- The standalone platform chart (deploy the platform without Shipwright) is a follow-up session, not in this one.
- CHM-1.1 done by Dan from a runbook; baseline kept out of repos.

## Tasks

| ID | Title | Repo | Cx / Model | Deps |
|---|---|---|---|---|
| CHM-1.1 | chore: capture the prod baseline ⚠ HITL (done) | shipwright | 1 / haiku | — |
| CHM-1.2 | test: render-parity tool and CI check | shipwright | 3 / sonnet | — |
| CHM-2.1 | feat: agent-platform library chart and publish workflow | agent | 3 / sonnet | — |
| CHM-2.2 | chore: enable Pages and verify anonymous resolution ⚠ HITL | agent | 1 / haiku | 2.1 |
| CHM-2.3 | refactor: shared helpers into the library | agent | 4 / sonnet | 2.1 |
| CHM-2.4 | refactor: admin and agent-provisioning templates | agent | 4 / sonnet | 2.3 |
| CHM-2.5 | refactor: chat and whisper templates | agent | 3 / sonnet | 2.3 |
| CHM-2.6 | refactor: shared networking and database templates with extension hooks | agent | 5 / opus | 2.4, 2.5 |
| CHM-2.7 | ci: notify shipwright on library release | agent | 2 / haiku | 2.1 |
| CHM-3.1 | refactor: depend on the library, switch helpers | shipwright | 4 / sonnet | 1.2, 2.2, 2.3 |
| CHM-3.2 | refactor: admin/agent stubs | shipwright | 3 / sonnet | 3.1, 2.4 |
| CHM-3.3 | refactor: chat/whisper stubs | shipwright | 3 / sonnet | 3.1, 2.5 |
| CHM-3.4 | refactor: shared templates via library with extension lists | shipwright | 5 / opus | 3.2, 3.3, 2.6 |
| CHM-3.5 | ci: receive library releases, bump pin, drift check | shipwright | 4 / sonnet | 3.1, 2.7 |
| CHM-4.1 | chore: roll the library-backed chart into prod ⚠ HITL | vitals-os | 3 / sonnet | 1.1, 3.4, 3.5 |
| CHM-5.1 | docs: shipwright chart docs | shipwright | 2 / haiku | 3.4 |
| CHM-5.2 | docs: library chart docs | agent | 2 / haiku | 2.6 |

Task bodies, acceptance criteria and branches are in the task store (`?session=chart-move`).

## Dependency map

```
1.2 ──────────────────────────────────────────┐
2.1 ─┬─ 2.2 (HITL) ──────────────────────────┤
     ├─ 2.3 ─┬─ 2.4 ─┬─ 2.6 ──────────────────┼─ 3.1 ─┬─ 3.2 ─┐
     │       └─ 2.5 ─┘                         │       ├─ 3.3 ─┼─ 3.4 ─┬─ 4.1 (HITL, Dan)
     └─ 2.7 ──────────────────────────────────────────┴─ 3.5 ──┘       └─ 5.1
1.1 (done) ───────────────────────────────────────────────────────────→ 4.1      2.6 → 5.2
```

## Breaking Change Safety

Chart name, release name, values keys and every rendered resource name are a compatibility contract and do not change. Every task up to CHM-3.4 is safe to deploy standalone (consumers are unaffected until the pin bump in CHM-4.1) provided the parity check is zero. Dropped Helm tests are only removed after the library copy exists (add, switch, remove).

## Risks and open items

- **CHM-2.6/3.4 are the hard part**: shared templates need extension hooks without changing output. Opus tier; parity gate is the proof.
- **Prune is destructive**: the empty `shipwright-admin/metrics/voice` Secrets are vestigial but must still render, so the managed set does not change silently.
- **Shared Cloud SQL instance**: take an on-demand backup before CHM-4.1 (backups and 7-day PITR already exist).
- Out of scope: standalone platform chart (follow-up), moving the deployable chart out of Shipwright, `shipwright-internal` Secret cleanup, specialists/vitals-os per-specialty images.
