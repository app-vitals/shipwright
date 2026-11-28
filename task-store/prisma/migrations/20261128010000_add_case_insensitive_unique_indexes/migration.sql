-- STI-1.1: case-insensitive uniqueness for Session.slug (per account) and Task.id.
-- Prisma cannot declare functional unique indexes, so they live only in this
-- raw SQL migration. Fails loudly, naming the colliding values, if any case
-- collisions exist when it runs (nothing is rewritten or deleted).

DO $$
DECLARE
  slug_collisions TEXT;
  id_collisions TEXT;
BEGIN
  SELECT string_agg(format('%s/%s => [%s]', "accountId", lslug, vals), '; ' ORDER BY "accountId", lslug)
    INTO slug_collisions
    FROM (
      SELECT "accountId", lower("slug") AS lslug, string_agg("slug", ', ' ORDER BY "slug" COLLATE "C") AS vals
        FROM "Session"
       GROUP BY "accountId", lower("slug")
      HAVING count(*) > 1
    ) c;

  SELECT string_agg(format('%s => [%s]', lid, vals), '; ' ORDER BY lid)
    INTO id_collisions
    FROM (
      SELECT lower("id") AS lid, string_agg("id", ', ' ORDER BY "id" COLLATE "C") AS vals
        FROM "Task"
       GROUP BY lower("id")
      HAVING count(*) > 1
    ) c;

  IF slug_collisions IS NOT NULL OR id_collisions IS NOT NULL THEN
    RAISE EXCEPTION 'STI-1.1: case-insensitive collisions block unique indexes. Session slugs: %. Task ids: %. Resolve these rows and re-run.',
      COALESCE(slug_collisions, 'none'), COALESCE(id_collisions, 'none');
  END IF;
END
$$;

-- CreateIndex
CREATE UNIQUE INDEX "Session_accountId_lower_slug_key" ON "Session" ("accountId", lower("slug"));

-- CreateIndex
CREATE UNIQUE INDEX "Task_lower_id_key" ON "Task" (lower("id"));
