# Architecture

High-level overview of how `ai-chat-session-api` works.

---

## What it is

A NestJS backend that hosts an agentic chat layer. Messages can arrive from multiple channels, but the core of the system does not know or care where a message came from. Every conversation is a **session** identified by a ULID, and every session is bound to a single **agent** that determines the system prompt and which tools are available.

The system is deliberately unopinionated about clients. Adding a new channel (email, SMS, voice, web UI) does not require changes to the core services — only a new adapter that translates inbound channel events into calls on `IdentityService` and `ChatSessionService`.

---

## Layered view

```
┌─────────────────────────────────────────────────────────────┐
│  Channel adapters                                           │
│  SendgridWebhookController → EmailReply · WebChatController │
│  (future: Twilio SMS, Twilio Voice)                         │
└───────────────────────────┬─────────────────────────────────┘
                            │ (source, externalId, agentName, text)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Identity layer                                             │
│  IdentityService — maps (source, externalId) → sessionUlid  │
└───────────────────────────┬─────────────────────────────────┘
                            │ sessionUlid, text
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Conversation core                                          │
│  ChatSessionService — the tool-use loop                     │
│   ├── AgentRegistryService → resolve agent for session      │
│   ├── ToolRegistryService  → filter tools by allowlist      │
│   ├── AnthropicService     → call Claude                    │
│   └── DynamoDB             → load / persist history         │
└───────────────────────────┬─────────────────────────────────┘
                            │ assistant text
                            ▼
                     channel reply
```

Each layer is a clean boundary. Adapters never talk to Anthropic or DynamoDB directly. The core never knows the channel format. Identity is the only thing that translates between external IDs and session ULIDs.

---

## Request lifecycle

A single inbound message flows through the system like this.

1. **Channel adapter receives raw input.**
   - Web chat: `WebChatController` accepts HTTP requests from the browser widget — `src/controllers/web-chat.controller.ts`.
   - Email reply: `SendgridWebhookController` accepts `POST /webhooks/sendgrid/inbound`, then `EmailReplyService` parses and validates the MIME payload — `src/controllers/sendgrid-webhook.controller.ts`, `src/services/email-reply.service.ts`.

2. **Adapter resolves identity.** The adapter calls `IdentityService.lookupOrCreateSession(source, externalId, agentName)`. This returns a `sessionUlid`. On first contact the service creates an `IDENTITY#...` record and a `CHAT_SESSION#<ulid>` `METADATA` record with the agent binding. On subsequent contacts it reads the existing record. A conditional write prevents race conditions.

3. **Adapter calls the core.** The adapter passes the `sessionUlid` and the user's plain text into `ChatSessionService.handleMessage(sessionUlid, userMessage)`.

4. **Core loads state.** `ChatSessionService` reads the session `METADATA` record to find the bound `agentName`, then resolves the agent via `AgentRegistryService.getByName(...)`. If the agent is not found, it falls back to `lead_capture`. Recent messages are loaded from DynamoDB (up to 50, most recent first, then reversed).

5. **Core filters tools.** `ToolRegistryService.getDefinitions()` returns every registered tool. `ChatSessionService` filters these against `agent.allowedToolNames` and only passes the filtered set to Anthropic. This is the primary purpose-enforcement mechanism — a tool that is not in the allowlist is never shown to the model.

6. **Tool-use loop.** The core runs a bounded loop (`MAX_TOOL_LOOP_ITERATIONS = 10`):
   - Call `AnthropicService.sendMessage(messages, tools, systemPrompt)`.
   - Append the assistant response to history.
   - If `stop_reason === "end_turn"`, exit.
   - If `stop_reason === "tool_use"`, for each `tool_use` block:
     - Defense-in-depth allowlist check — re-verify the tool is in `agent.allowedToolNames`. If not, return an error `tool_result`.
     - Dispatch to `ToolRegistryService.execute(name, input, { sessionUlid })`.
     - Append a `tool_result` block to history.
   - Loop.

7. **Persist.** Every new message produced in this call (the user message, assistant turns, and tool results) is written to DynamoDB as `MESSAGE#<ulid>` records. The `METADATA` record's `lastMessageAt` is updated. `createdAt` is preserved via `if_not_exists`.

8. **Return.** The final assistant text is extracted from the last assistant message's `text` blocks, joined, and returned to the adapter.

9. **Channel adapter replies.** The adapter formats and sends the reply in its native channel (threaded email reply, web chat response, etc.).

---

## Key design decisions

**Sessions are channel-agnostic.** A `sessionUlid` is just a ULID. It carries no knowledge of email, web, or anything else. The same ULID can in principle be reached from any channel — the identity layer is what decides which external IDs map to it. See [concepts.md](./concepts.md) for how `(source, externalId)` works.

**Agents are configuration, not code.** An agent is a NestJS provider that implements the `ChatAgent` interface — `name`, `description`, `systemPrompt`, `allowedToolNames`. It contains zero orchestration logic. The core `ChatSessionService` is generic. Adding a new agent never requires changes to the core. See [agents-and-tools.md](./agents-and-tools.md).

**Tool allowlists are hard constraints.** Tool purpose-enforcement is done in two places: (a) by filtering the tool list *before* sending it to Anthropic — the model physically cannot call a tool it cannot see — and (b) by re-checking the allowlist inside the tool-use loop before dispatch. A prompt-engineering jailbreak cannot bypass either layer.

**Auto-discovery via decorators.** Both agents and tools register themselves via `@ChatAgentProvider()` / `@ChatToolProvider()` decorators. `AgentRegistryService` and `ToolRegistryService` walk the NestJS DI container on module init using `DiscoveryService` and collect providers marked with the decorator. Registering a new agent or tool is a single `providers: [...]` entry in `AppModule`.

**Single-table DynamoDB.** One table holds everything: identities, session metadata, messages, contact info, long-term facts, inbound email dedupe records. Access patterns are expressed through PK/SK conventions — see [data-model.md](./data-model.md).

**Structured content blocks.** Messages are stored as JSON arrays of `ChatContentBlock` objects (`text`, `tool_use`, `tool_result`) — the same shape the Anthropic SDK uses. No translation layer is needed when replaying history.

---

## What lives where

- `src/main.ts` — NestJS bootstrap.
- `src/app.module.ts` — the single root module; registers config, providers, agents, and tools.
- `src/services/chat-session.service.ts` — the tool-use loop.
- `src/services/identity.service.ts` — channel-agnostic session lookup/creation.
- `src/services/anthropic.service.ts` — thin wrapper around the Anthropic SDK.
- `src/agents/agent-registry.service.ts` · `src/tools/tool-registry.service.ts` — decorator-based registries.
- `src/agents/*.agent.ts` — agent definitions.
- `src/tools/*.tool.ts` — tool definitions.
- `src/controllers/web-chat.controller.ts` — web chat channel adapter.
- `src/controllers/sendgrid-webhook.controller.ts` · `src/services/email-reply.service.ts` — email inbound adapter.
- `src/services/email.service.ts` — outbound email via SendGrid.
- `src/types/*.ts` — shared interfaces.
- `src/config/env.schema.ts` · `src/config/configuration.ts` — env validation and typed config.
- `src/providers/dynamodb.provider.ts` — DynamoDB client factory.

See [agents-and-tools.md](./agents-and-tools.md) for a catalog of what currently ships.
