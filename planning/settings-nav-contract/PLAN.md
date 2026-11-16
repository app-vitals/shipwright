# Plan: settings-nav-contract

Session: `settings-nav-contract` · Repo: app-vitals/shipwright (+ producer task in app-vitals/agent)

## Problem
The Templates link is missing from the settings sidebar on coding-extension pages
(System crons, Notifications). The platform builds the sidebar from flags
(`agent/admin/src/admin-ui.ts` `buildSettingsNav({githubEnterprise, templates, accounts, extraItems})`).
Extension UI routes are not given that nav, so `codingSettingsNav()`
(`admin/src/coding/coding-settings-nav.ts`) rebuilds a partial copy that passes only
`githubEnterprise: true`. Account/Accounts (self-serve-flag dependent) are missing too.

Verified: `/admin/settings/templates` is mounted in shipwright (admin-boot builds
`AgentTemplateService` unconditionally), so the link will not 404.

The agent details page is low risk: its nav comes from the single `AGENT_SECTIONS`
constant and bodies are typed `Record<AgentSection, string>`; extensions add cards, not
sections. No task.

## Design
1. SNC-1.1 (shipwright): add `templates: true` to `codingSettingsNav()` + a contract smoke
   test comparing sidebar link sets on System crons / Notifications against the platform
   Templates page (reference), ignoring the active item.
2. SNC-2.1 (agent, additive): platform exposes the viewer-resolved `settingsNav` (the
   same one `/admin/settings` computes, including the account-less Account strip) to
   extension UI routes via request context + exported getter. Generic: whole nav, not
   Templates-specific. Test: for every flag-gated platform page, nav item present iff
   route registered.
3. SNC-2.2: release gate on the new @app-vitals/agent-admin version.
4. SNC-3.1 (shipwright): delete `codingSettingsNav()`, pages use platform nav; keep the
   SNC-1.1 contract test as the guard.

## Tasks
| Task | Repo | Depends on | Complexity |
|---|---|---|---|
| SNC-1.1 | shipwright | — | 2 (haiku) |
| SNC-2.1 | agent | — | 4 (sonnet) |
| SNC-2.2 | shipwright | SNC-2.1 | 1 (haiku) |
| SNC-3.1 | shipwright | SNC-2.2 | 3 (sonnet) |

Breaking Change Safety: all additive until SNC-3.1, which removes a local helper and
updates its two callers (admin-ui-system-crons.ts, admin-ui-sessions.ts) atomically.
Known interim gap: Account/Accounts remain absent on coding pages (self-serve on) until SNC-3.1.

HITL scan: no tasks require human steps.
