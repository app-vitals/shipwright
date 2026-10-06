# Plan: login-provider-visibility

Repo: app-vitals/shipwright · Requested by Dan · Approved in plan session.

## Problem
`renderLoginPage` (admin/src/admin-ui-pages.ts) always renders "Sign in with Google";
Okta is added alongside when configured. In chart `auth.mode=okta` the Google env vars
are never injected, so the Google button dead-ends in `/admin/login?error=server_error`.

## Design
| Layer | Change |
|---|---|
| Business logic | `admin-ui.ts` `/admin/login`: add `googleEnabled = Boolean(googleClientId && googleClientSecret)` beside `oktaEnabled`; pass both to `renderLoginPage`. Both vars required (callback needs both). |
| View | `renderLoginPage` gains `googleEnabled?: boolean`, **defaulting to true** when omitted (backward compatible). Google button renders only when true. |
| Neither configured | Render an `alert-error`-style notice: "No sign-in provider is configured. Set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET or OKTA_*." No buttons. |
| API / DB | None. `/admin/auth/google` unchanged (already fails closed to `server_error`); route hardening is an optional follow-up, out of scope. |

Both providers configured → both buttons show ("show what's configured", not "Okta wins").

Breaking-change scan: additive; safe to deploy standalone.

## Tests
- Unit (`admin-ui-pages.unit.test.ts`): existing Google tests stay valid via default; add google-off+okta-on (Okta only), both on, neither on (notice, no buttons), returnTo on each rendered button.
- Smoke (`admin-ui.smoke.test.ts`): mock deps set Google creds so existing test passes; add Google-empty+Okta-set and neither-set cases.
- E2E (`admin/e2e/login-page.e2e.ts`): test server sets Google creds; no change.
- Retired: none.

## Tasks
| ID | Title | Layer | Deps | HITL | Complexity/Model | Hours |
|---|---|---|---|---|---|---|
| LPV-1.1 | Show only configured providers on admin login page | Frontend | — | no | 3 / sonnet | 2 |

Branch: `feat/lpv-1-1-hide-unconfigured-login-providers`

```
[START]
  └─ LPV-1.1 (no deps)
```

Docs touched by LPV-1.1: docs/deploy-kubernetes.md (~L136), docs/configuration-agent.md, docs/agent-ops.md.
