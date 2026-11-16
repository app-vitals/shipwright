# Plan: renovate-5196

Replaces Renovate bundle PR app-vitals/shipwright#5196 (`renovate/routine-dependency-updates`), which is conflicting with main, un-rebaseable by Renovate (non-Renovate patch commit), and red on the coverage gate (Functions 88.68% < 89%) after the bun 1.4.3 -> 1.4.4 bump (cause unconfirmed).

## Design
Split the bundle so routine bumps are not held hostage by the bun change.
1. Land all non-bun bumps on a fresh branch off main, with a new chart version bump + CHANGELOG (main chart is 1.32.192; the 1.32.191 bump in #5196 is stale).
2. Isolate bun 1.4.4 (pinned at ci.yml:145, platform-release.yml:113, platform-release-retry.yml:64) into its own change; compare function counts on 1.4.3 vs 1.4.4 to confirm cause. Never lower `THRESHOLD_FUNCTIONS` (scripts/check-coverage.ts) unattended — if the gate cannot go green, block with evidence for a human decision.

## Tasks
| Task | Title | Depends on | HITL |
|---|---|---|---|
| RDU-1.1 | build: apply routine dependency bumps (excl. bun) | — | no |
| RDU-1.2 | build: bump bun to 1.4.4 and resolve coverage gate | RDU-1.1 | no (may block) |

RDU-1.2 depends on RDU-1.1 only to avoid workflow-file merge conflicts.

Safe to deploy standalone: yes (both tasks).
