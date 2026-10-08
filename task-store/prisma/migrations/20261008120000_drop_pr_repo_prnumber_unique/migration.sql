-- SSP-6.4: drop the old PullRequest [repo, prNumber] unique. The
-- [accountId, repo, prNumber] unique (SSP-6.1) is now the only PR key, so two
-- accounts may hold the same repo#prNumber.

-- DropIndex
DROP INDEX "PullRequest_repo_prNumber_key";
