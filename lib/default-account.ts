/**
 * The account every pre-multi-tenancy task-store row belongs to. Never use
 * NULL for task-store accountId — the column is NOT NULL DEFAULT 'default'.
 */
export const DEFAULT_ACCOUNT_ID = "default";
