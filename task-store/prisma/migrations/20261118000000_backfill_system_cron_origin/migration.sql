-- SCM-2.2: backfill typed origin provenance on pre-existing system-cron tasks.
-- Task ids are 'SC-' || cronId || '-' || slot || '-' || repo. Cron ids contain
-- hyphens, so join on the literal prefix rather than splitting the id. When one
-- cron id is a hyphen-prefix of another, the longest matching id wins.
-- Data-only, no schema change. Idempotent. Also rewrites originRef for rows
-- stamped by the old code with the display name.
UPDATE "Task" AS t
SET "originKind" = 'cron',
    "originRef" = m."cronId"
FROM (
  SELECT DISTINCT ON (t2."id") t2."id" AS "taskId", d."id" AS "cronId"
  FROM "Task" AS t2
  JOIN "SystemCronDefinition" AS d
    ON t2."id" LIKE 'SC-' || d."id" || '-%'
  WHERE t2."source" = 'system-cron'
    AND (t2."originKind" IS NULL
         OR (t2."originKind" = 'cron' AND t2."originRef" = d."name"))
  ORDER BY t2."id", length(d."id") DESC
) AS m
WHERE t."id" = m."taskId";
