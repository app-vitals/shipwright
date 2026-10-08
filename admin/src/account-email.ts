/**
 * admin/src/account-email.ts
 * Shared email normalization for the account services (SSP-1.2). All account
 * emails are lowercased (and trimmed) on write and on read.
 */

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
