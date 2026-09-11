-- Backfill the auto-follow opt-in boundary for pre-existing prefs rows.
--
-- `UserNotificationPrefs.autoFollowSessions` defaults to true and a row is
-- created just by loading the session settings page, so every row that existed
-- before session-alert-sweeper.ts shipped sits in the null ("no boundary")
-- cohort. Without this backfill the sweeper's first tick after deploy would
-- auto-follow every currently-waiting session for those users and immediately
-- push each one — the pre-existing-backlog burst the boundary exists to
-- prevent.
--
-- Data-only: no schema change. Stamping `now()` means "auto-follow starts
-- here", so only sessions that start waiting after the deploy are
-- auto-followed. Explicit follows are untouched.
UPDATE "UserNotificationPrefs"
SET "autoFollowSince" = CURRENT_TIMESTAMP
WHERE "autoFollowSince" IS NULL;
