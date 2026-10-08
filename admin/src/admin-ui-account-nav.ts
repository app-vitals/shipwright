/**
 * admin/src/admin-ui-account-nav.ts
 * Per-request "show the Account nav entry" flag (SSP-3.2). renderAdminToolbar()
 * is called from dozens of page renderers; rather than thread a parameter
 * through all of them, an admin-ui middleware wraps each /admin/* request in
 * runWithAccountNav() and the toolbar reads the flag back. Outside any
 * context (tests, other services) the entry is hidden.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<{ showAccount: boolean }>();

export function runWithAccountNav<T>(showAccount: boolean, fn: () => T): T {
  return storage.run({ showAccount }, fn);
}

export function shouldShowAccountNav(): boolean {
  return storage.getStore()?.showAccount === true;
}
