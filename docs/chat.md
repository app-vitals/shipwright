# Chat Service

The chat service (threads, messages, tokens and the claim/reply queue behind the admin console's Chat tab and the agent's chat poll loop) is no longer part of this repo. It is hosted in the platform repo, [app-vitals/agent](https://github.com/app-vitals/agent), and published as the `ghcr.io/app-vitals/agent-chat` image, which the Helm chart in `charts/shipwright` deploys.

- Service guide (auth model, data model, environment, queue behavior) and the chat OpenAPI document: see [platform/chat-service.md](platform/chat-service.md), a snapshot of the platform repo's docs.
- Running it locally: see [local platform development](local-platform-development.md#running-chat-task-stack).
