# Plan: playwright-install-retry

## Pass 1 — 2026-11-28

### Problem
3 of the last 60 main CI runs failed at a Playwright browser-install step (runs 46082498728, 46095518253, 46116986468). `playwright install --with-deps` runs `apt-get install` on ubuntu-26.04 runners; on the failing runs apt could not locate Ubuntu packages (`E: Unable to locate package fonts-unifont`, exit 100) because `apt-get update` fetched only the Microsoft repo, not the Ubuntu archive. Passing runs used the same image, so this is intermittent runner/mirror trouble, not a code or image issue.

### Design
Add composite action `.github/actions/install-playwright`: `sudo apt-get update`, then retry `playwright install --with-deps <browser>` up to 3 times with a short sleep. Inputs: browser and working directory / binary. Replace all 6 call sites (ci.yml x4, preview.yml, preview-test.yml). No code or test changes.

Risk: preview workflows check the trusted ref out to `trusted/`, so the `uses:` path differs per workflow and must be verified.

### Tasks
| Task | Depends on | HITL |
|---|---|---|
| PIR-1.1 ci: retry playwright browser install via composite action | — | |

Safe to deploy standalone: yes (additive action, call sites swapped atomically in one PR).

### Decision Log
- Single task: the 6 swaps are mechanical and a half-migrated state is worse than none.
