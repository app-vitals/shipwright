# Plan: github-apps-cron-scope

Three related changes, spanning `app-vitals/agent` (platform, prefix `LKP`) and `app-vitals/shipwright` (prefix `CRS`):

1. Per-cron repo selection on `/admin/settings/system-crons` ("All repositories" / "Only select repositories").
2. The GitHub lookup App works without the installer App (and without a GitHub Enterprise account).
3. Installer and lookup Apps can be assigned to an account, with fallback to the deployment-wide pair.

Plus: release gates resolve the release by producer **task id**, not a hardcoded version.

## Design

### Platform (`app-vitals/agent`, `admin/src`)
- `GithubLookupClient.listInstallations()` calls `GET /app/installations` (App JWT). `createGithubLookupService` works with only a lookup row; with an installer configured, the org list still comes from it (unchanged).
- `GitHubEnterpriseApp` gains nullable `accountId`; unique on `(accountId, role)` with a partial unique index for the NULL (deployment-wide) rows, same pattern as `AgentTemplate`. Existing rows stay `accountId = null`.
- `appService.get(role, accountId?)` returns the account's row, else the deployment-wide row. Consumers updated: settings routes, github-access resolver, `createGithubLookupService`, `github-installation-wiring`. `githubLookup.listRepositories(accountId?)` is an optional arg (additive).
- UI: the lookup card shows different instructions when no installer exists (manual install on each org, link `github.com/apps/<slug>/installations/new`); account selector on both cards; docs updated.

### Shipwright
- `SystemCronDefinition`: `repoScope String @default("all")`, `repos String[] @default([])` (additive; existing crons stay "all").
- Service/API validates `repos` with `isValidSystemCronRepo`; `selected` requires >= 1 repo.
- Scheduler intersects the lookup listing with the selection (archived/invisible repos drop out). Later, lists per account.
- UI: radio pair plus searchable checklist fed by the lookup listing.
- Release gate by task id: `scripts/check-platform-pin.sh --task <ID> <package>` resolves the producer task's PR merge commit, finds the first agent release containing it, and runs the existing pin check at that version. The `<package> <minVersion>` form stays for compatibility.

## Tasks

| Task | Repo | Title | Depends on | Cplx / model |
|---|---|---|---|---|
| LKP-1.1 | agent | feat: lookup App lists its own installations when no installer is configured | — | 3 / sonnet |
| LKP-1.2 | agent | feat: add accountId to GitHubEnterpriseApp with fallback resolution | — | 5 / opus |
| LKP-1.3 | agent | feat: scope GitHub Apps settings, resolver, wiring and lookup service by account | 1.1, 1.2 | 4 / sonnet |
| LKP-1.4 | agent | feat: no-installer instructions and account selector on GitHub Apps settings | 1.3 | 3 / sonnet |
| CRS-0.1 | shipwright | feat: gate release by producer task id in check-platform-pin | — | 4 / sonnet |
| CRS-1.1 | shipwright | feat: add repoScope and repos to SystemCronDefinition | — | 3 / sonnet |
| CRS-1.2 | shipwright | feat: scheduler intersects lookup listing with cron repo selection | 1.1 | 3 / sonnet |
| CRS-1.3 | shipwright | feat: repo selection UI on system-crons page | 1.1 | 4 / sonnet |
| CRS-2.1 | shipwright | chore: wait for release containing LKP-1.4 in shipwright | LKP-1.4, CRS-0.1 | 1 / haiku |
| CRS-2.2 | shipwright | feat: per-account repo listing in system-cron scheduler | 2.1, 1.2 | 3 / sonnet |

Bundles: LKP-1.3 + LKP-1.4 (`feat/lkp-account-scoped-apps`); CRS-1.2 + CRS-1.3 (`feat/crs-cron-repo-selection`).

```
[START]
  ├─ LKP-1.1, LKP-1.2 ──> LKP-1.3 ──> LKP-1.4 ──┐
  ├─ CRS-0.1 ───────────────────────────────────┴─> CRS-2.1 ──> CRS-2.2
  └─ CRS-1.1 ──> CRS-1.2, CRS-1.3 ───────────────────────────────^ (1.2)
```

Safe to deploy standalone: yes for every task (additive schema, optional args, nullable columns; no renames or removals).

HITL scan: no tasks require human steps.
