import { describe, expect, it } from "bun:test";
import { buildDeletionClients } from "./admin-boot-config.ts";
import {
  HttpChatServiceProvisioningClient,
  NoopChatServiceProvisioningClient,
} from "./chat-service-provisioning-client.ts";
import {
  HttpTaskStoreProvisioningClient,
  NoopTaskStoreProvisioningClient,
} from "./task-store-provisioning-client.ts";

describe("buildDeletionClients", () => {
  it("returns no-op clients when nothing is configured", () => {
    const { taskStore, chatService } = buildDeletionClients({});
    expect(taskStore).toBeInstanceOf(NoopTaskStoreProvisioningClient);
    expect(chatService).toBeInstanceOf(NoopChatServiceProvisioningClient);
  });

  it("needs both the URL and the admin token for each real client", () => {
    const { taskStore, chatService } = buildDeletionClients({
      SHIPWRIGHT_TASK_STORE_URL: "http://task-store.test",
      SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN: "chat-admin",
    });
    expect(taskStore).toBeInstanceOf(NoopTaskStoreProvisioningClient);
    expect(chatService).toBeInstanceOf(NoopChatServiceProvisioningClient);
  });

  it("builds real clients when fully configured, independent of K8s provisioning", () => {
    const { taskStore, chatService } = buildDeletionClients({
      SHIPWRIGHT_TASK_STORE_URL: "http://task-store.test",
      SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN: "ts-admin",
      SHIPWRIGHT_CHAT_SERVICE_URL: "http://chat.test",
      SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN: "chat-admin",
    });
    expect(taskStore).toBeInstanceOf(HttpTaskStoreProvisioningClient);
    expect(chatService).toBeInstanceOf(HttpChatServiceProvisioningClient);
  });
});
