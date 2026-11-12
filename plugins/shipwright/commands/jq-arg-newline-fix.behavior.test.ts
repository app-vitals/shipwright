import { describe, expect, test } from "bun:test";
import { join } from "path";
import { $, file } from "bun";

describe("JNL-1.1 behavioral test: jq --arg headRefOid properly matches compute-unaddressed-findings", () => {
  test("headRefOid=abc with --arg headRefOid matches review.commit.oid=abc", async () => {
    const HEAD_REF_OID = "abc";
    const CURRENT_USER = "the-agent";
    const PR_AUTHOR = "pr-author";

    // Build the jq command using --arg instead of jq -Rs . <<<
    // This mirrors the fixed command in patch.md Step 3a and review.md Step 9.5
    const jqCmd = `jq -n --arg currentUser "${CURRENT_USER}" \
      --arg prAuthor "${PR_AUTHOR}" \
      --arg headRefOid "${HEAD_REF_OID}" \
      --argjson reviews '{"nodes":[{"author":{"login":"reviewer1"},"state":"CHANGES_REQUESTED","submittedAt":"2024-01-01T00:00:00Z","commit":{"oid":"${HEAD_REF_OID}"},"body":"Please fix this"}]}' \
      --argjson reviewThreads '{"nodes":[]}' \
      --argjson comments '{"nodes":[]}' \
      --argjson findings '[]' \
      '{currentUser: $currentUser, prAuthor: $prAuthor, headRefOid: $headRefOid, reviews: $reviews, reviewThreads: $reviewThreads, comments: $comments, findings: $findings}'`;

    // Run the jq command
    const jqResult = await $`sh -c ${jqCmd}`.text();

    // Parse the jq output
    const input = JSON.parse(jqResult);

    // Verify that headRefOid is exactly "abc" with no trailing newline
    expect(input.headRefOid).toBe("abc");
    // Make sure it's not "abc\n" or similar
    expect(input.headRefOid.length).toBe(3);

    // Now feed this to compute-unaddressed-findings.ts and verify it detects the finding
    // The review's commit.oid matches headRefOid, so hasUnaddressedFindings should be true
    const scriptPath = join(import.meta.dir, "..", "scripts", "compute-unaddressed-findings.ts");
    const inputJson = JSON.stringify(input);

    const computeResult = await $`echo ${inputJson} | bun run ${scriptPath}`.text();

    // Parse the output
    const result = JSON.parse(computeResult);

    // The review is a CHANGES_REQUESTED at the current head with no prior resolution,
    // so unaddressedFindings should be true
    expect(result.unaddressedFindings).toBe(true);
  });
});
