# Plan: cross-repo-pin-flow

Streamline the breaking-change flow between app-vitals/agent (published @app-vitals/agent-* packages) and app-vitals/shipwright (pin consumer).

## Findings
- platform-release.yml already opens and admin-merges the pin-bump PR; the gap is the failure path (red bump never retried after the fix lands; 0.16.2 run failed 2026-10-31, shipwright#4693 left open).
- agent has consumer-smoke.yml (post-publish only); nothing checks shipwright against an unreleased agent build.
- plan-session has add->migrate->remove for in-repo callers only; cross-repo consumers are invisible to grep.
- shipwright CI has no task-store token secret.

## Tasks
| ID | Repo | Summary | Depends on |
|---|---|---|---|
| XPF-1.1 | shipwright | retry red/stale platform bump | - |
| XPF-2.1 | agent | consumer-compat CI (advisory) | - |
| XPF-2.2 | agent | HITL: make it required after soak | XPF-2.1 |
| XPF-3.1 | shipwright | HITL: provision task-store token secret | - |
| XPF-3.2 | shipwright | requiresPackage metadata + auto-unblock on bump merge | XPF-3.1 |
| XPF-4.1 | shipwright | plan-session expand/migrate/contract rule for published contracts | XPF-3.2 |
| XPF-5.1 | shipwright | deploy auto-clears stale post-merge-CI-failed block | - |
| XPF-5.2 | shipwright | diagnose + repair deploying/merged drift | - |

## Decision Log
- XPF-2.1 scope: defaulted to fast shipwright checks only (typecheck, admin-gen drift, seed + migration guard) - full suite is costly per agent PR.
- XPF-3.2 trigger: defaulted to bump-workflow-driven unblock - task-store has no GitHub access.
- XPF-5.2: diagnose-first; may split once root cause is known.
