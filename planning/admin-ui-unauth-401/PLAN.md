# Plan: admin-ui-unauth-401

Main CI red since #4618 (agent-* 0.9.0 -> 0.12.0). Five admin UI smoke tests expect 302 -> /admin/login for
unauthenticated requests but get 401. Cause: platform `createUIAuthMiddleware` (agent-admin) now redirects only
navigation requests (`Sec-Fetch-Mode: navigate` or `Accept: text/html`); others get `401 {"error":"signed_out"}`.
Intentional platform change; tests send no headers. Fix is test-side.

| Task | Depends on |
|---|---|
| AUR-1.1 fix: update admin UI unauthenticated-redirect tests for the navigation-aware 401 | — |

Safe to deploy standalone: yes (tests only).

## Decision Log
- Scope: test-only fix plus a 401-contract test per route family, per Dan's approval.
