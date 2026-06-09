import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_AGENT_HOME = join(
  tmpdir(),
  `shipwright-agent-test-${process.pid}`,
);

mkdirSync(join(TEST_AGENT_HOME, "workspace"), { recursive: true });
writeFileSync(
  join(TEST_AGENT_HOME, "workspace", "CLAUDE.md"),
  "# Shipwright Agent\n",
);

process.env.AGENT_HOME = TEST_AGENT_HOME;
process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
process.env.SLACK_APP_TOKEN = "xapp-test-token";
process.env.SLACK_SIGNING_SECRET = "test-signing-secret";
process.env.ANTHROPIC_MODEL = "claude-opus-4-6";
process.env.SLACK_ALERT_CHANNEL = "#alerts";
process.env.SLACK_OWNER_USER = "U12345";
process.env.SHIPWRIGHT_API_URL = "https://api.shipwright.app";
process.env.SHIPWRIGHT_INTERNAL_API_KEY = "key-123";
process.env.SHIPWRIGHT_AGENT_ID = "agent-test-456";
