-- AlterTable
ALTER TABLE "PullRequest" ADD COLUMN     "commitCount" INTEGER,
ADD COLUMN     "commitsCiFix" INTEGER,
ADD COLUMN     "commitsDocsRefresh" INTEGER,
ADD COLUMN     "commitsImplementation" INTEGER,
ADD COLUMN     "commitsReviewPatch" INTEGER;
