# Plan: mnav — metrics navbar missing "Settings" + drift prevention

## Root cause
Metrics and admin both render `renderShipwrightToolbar` from `@app-vitals/agent-lib`
(`lib/web/toolbar.ts` in app-vitals/agent). `showSettings` is opt-in and defaults to
`false`. Admin enables it per request (`runWithSettingsNav` -> `shouldShowSettingsNav()`
-> `admin-ui-styles.ts`). `metrics/src/dashboard/dashboard-page.ts` calls the toolbar
without `showSettings`, so Settings never renders. No test compares the metrics navbar
to the shared toolbar, so nothing failed.

## Design
Rule (Dan): Settings is shown only to admins (`isAdmin`) or owners (role `OWNER`).
Hiding the link is cosmetic; `/admin/settings` enforces access itself.

1. **Fix (shipwright/metrics):** compute `showSettings` server-side in the authenticated
   `/dashboard` handler; pass via a new `DashboardPageOptions.showSettings`. Public
   read-only and 403 pages stay off. Missing signal => hidden.
2. **Generic guard (shipwright/metrics):** a contract test renders the shared toolbar with
   every boolean option on, collects all nav links, and asserts the metrics owner render
   contains each one, except entries in an explicit `INTENTIONALLY_HIDDEN` map (reason
   required). Also asserts the public render has no gated links. New upstream nav items
   fail it until metrics opts in or exempts them.
3. **Upstream (app-vitals/agent):** expand/migrate/contract.
   - Expand: required-by-type `audience: "admin" | "member" | "public"` option plus exported
     `TOOLBAR_NAV_ITEMS` manifest (item -> audiences). Legacy booleans stay. The admin
     bridge (`admin/src/admin-ui-account-nav.ts`, `admin-ui-styles.ts`) lives in the same
     repo and is migrated in the same task.
   - Release gate, then migrate shipwright metrics to `audience` and point the guard at the manifest.
   - Contract: remove legacy visibility booleans.

## Tasks
| Task | Repo | Depends on | Model |
|---|---|---|---|
| MNAV-1.1 fix: show Settings in metrics navbar for admins and owners | shipwright | - | sonnet |
| MNAV-1.2 test: guard metrics navbar against shared-toolbar drift | shipwright | 1.1 | sonnet |
| MNAV-2.1 feat: audience-based toolbar API in agent-lib | agent | - | opus |
| MNAV-2.2 chore: wait for @app-vitals/agent-lib >= X in shipwright | shipwright | 2.1 | haiku |
| MNAV-2.3 refactor: migrate metrics toolbar to audience API | shipwright | 2.2, 1.2 | sonnet |
| MNAV-2.4 refactor: remove legacy toolbar visibility flags | agent | 2.3 | sonnet |

Breaking-change safety: 1.1/1.2/2.1 additive. 2.4 removes booleans only after 2.3 migrates
all known consumers (metrics; admin migrated in 2.1). Consumers outside these repos are
not visible to grep — 2.4 must confirm none before removal.

## Decision Log
- Settings audience: admin or owner only (Dan).
- Upstream follow-up and 2.4 included (Dan).
