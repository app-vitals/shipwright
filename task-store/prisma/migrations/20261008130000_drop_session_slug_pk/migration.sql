-- SSP-6.9: drop the slug-only Session primary key. The
-- "Session_accountId_slug_key" unique index (SSP-6.1) already exists and is now
-- the sole identity, so two accounts may hold the same slug.

-- AlterTable
ALTER TABLE "Session" DROP CONSTRAINT "Session_pkey";
