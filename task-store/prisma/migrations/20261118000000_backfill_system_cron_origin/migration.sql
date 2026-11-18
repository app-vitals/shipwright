-- SCM-2.2: backfill typed origin provenance on pre-existing system-cron tasks.
-- Task ids are 'SC-' || cronId || '-' || slot || '-' || repo. Cron ids contain
-- hyphens, so join on the literal prefix rather than splitting the id.
-- Data-only: no schema change. Idempotent (only touches originKind IS NULL).
-- Also rewrites originRef for rows previously stamped with the display name.
UPDATE "Task" AS t
SET "originKind" = 'cron',
    "originRef" = d."id"
FROM "SystemCronDefinition" AS d
WHERE t."source" = 'system-cron'
  AND t."originKind" IS NULL
  AND t."id" LIKE 'SC-' || d."id" || '-%';

-- Rows stamped by the old code (originRef = display name) get the cron id.
UPDATE "Task" AS t
SET "originRef" = d."id"
FROM "SystemCronDefinition" AS d
WHERE t."source" = 'system-cron'
  AND t."originKind" = 'cron'
  AND t."originRef" = d."name"
  AND t."id" LIKE 'SC-' || d."id" || '-%';
