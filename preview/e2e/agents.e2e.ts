import { expect, test } from "@playwright/test";
import {
  adminSessionToken,
  authenticate,
  createAgent,
  deleteAgent,
  requireEnv,
  uniqueName,
} from "./helpers.ts";

const adminUrl = requireEnv("PREVIEW_ADMIN_URL");
const name = uniqueName("e2e-agent");
let token: string;
let agentId: string | undefined;

test.beforeAll(async () => {
  token = await adminSessionToken(adminUrl);
  agentId = await createAgent(adminUrl, token, name);
});

test.afterAll(async () => {
  if (agentId) await deleteAgent(adminUrl, token, agentId);
});

test("an agent created via the admin API appears on the agents page", async ({
  page,
  context,
}) => {
  await authenticate(context, token, [adminUrl]);
  await page.goto("/admin/agents");
  await expect(page.getByText(name).first()).toBeVisible();
});
