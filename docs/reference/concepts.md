# Concepts

The vocabulary you need to read the rest of these docs.

---

## Session

A **session** is one continuous conversation with the system. It is identified by a **session ULID** — a 26-character lexicographically sortable identifier. A session has no inherent channel affinity: it is just a row (technically, a group of rows) in DynamoDB under `CHAT_SESSION#<ulid>`.

A session holds:

- **Metadata** — the agent it is bound to, the originating source, timestamps.
- **Messages** — the full chat history as structured content blocks.
- **Per-agent state** — e.g. collected contact info, saved user facts.

Sessions persist forever. When a user comes back, we look them up and resume.

---

## Identity

An **identity** is a mapping from an external ID to a session ULID. External IDs come in tuples of `(source, externalId)`:

| source | externalId example |
|---|---|
| `discord` | Discord user ID (`123456789012345678`) |
| `email` | `alice@example.com` |
| `sms` (future) | phone number |
| `voice` (future) | phone number |
| `web` (future) | guest cookie / auth user ID |

The identity record sits at PK/SK `IDENTITY#<source>#<externalId>` and points at the session ULID. `IdentityService.lookupOrCreateSession(source, externalId, agentName)` is the single entry point: if the identity exists, return its session ULID; if not, create a new session and bind the given agent to it.

This design lets one human be reachable across multiple channels while keeping a clean 1:1 mapping inside any single channel. A future enhancement can introduce a "merge" operation that points two identities at the same session.

---

## Channel (source)

A **channel** is an external surface through which messages flow. Each channel has:

- An **adapter** — a NestJS service or controller that owns the channel's SDK or webhook.
- A **source name** — a short string (`discord`, `email`, etc.) used in identity records.
- Its own reply mechanism — Discord DM, threaded email reply, etc.

Channels today:

- [Discord](./channels/discord.md) — `DiscordService` (`src/services/discord.service.ts`)
- [Email](./channels/email.md) — `SendgridWebhookController` + `EmailReplyService` for inbound, `EmailService` for outbound

Channels planned:

- Twilio SMS
- Twilio Voice (real-time transcription → chat core → TTS reply)
- HTTP / web client

A channel adapter's job is minimal: receive a message, resolve identity, call the core, send the reply. That's it. No business logic lives in the adapter.

---

## Agent

An **agent** is a configuration object that defines a bounded AI persona. Every agent implements the `ChatAgent` interface (`src/types/ChatAgent.ts`):

```ts
interface ChatAgent {
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly allowedToolNames: readonly string[];
}
```

- **name** — a stable identifier (`lead_capture`). Used as the binding stored on each session.
- **description** — human-readable summary of the agent's job.
- **systemPrompt** — the full system prompt that shapes behavior, tone, and scope.
- **allowedToolNames** — the exact list of tool names the agent is allowed to invoke. Enforced at the code level.

Agents contain no orchestration logic. They are pure configuration, discovered at runtime via the `@ChatAgentProvider()` decorator.

Each session is bound to exactly one agent via the `agentName` field in its `METADATA` record. The binding is set the first time the identity is created and does not change during the session's lifetime.

Today the only agent that ships is [`lead_capture`](./agents-and-tools.md#lead_capture).

---

## Tool

A **tool** is a concrete capability the model can invoke during a conversation. Every tool implements the `ChatTool` interface (`src/types/Tool.ts`):

```ts
interface ChatTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ChatToolInputSchema;
  execute(input: unknown, context: ChatToolExecutionContext): Promise<ChatToolExecutionResult>;
}
```

Tools are decorated with `@ChatToolProvider()` and auto-discovered by `ToolRegistryService`. They are channel-agnostic — they receive the `sessionUlid` in the execution context and can read/write DynamoDB, call external services, or do anything else.

A tool does not belong to any particular agent. Any agent that lists the tool's name in its `allowedToolNames` array can use it; any agent that does not will never even see it. This is how multiple agents can share a capability (e.g. `send_email`) without coupling them.

Today the tools that ship are `collect_contact_info`, `send_email`, and `save_user_fact`. See [agents-and-tools.md](./agents-and-tools.md).

---

## Tool-use loop

Anthropic's tool-use protocol is turn-based. The model replies with one or more `tool_use` content blocks, the server executes each tool, and then feeds the results back in as `tool_result` blocks on the next call. `ChatSessionService.handleMessage(...)` runs this loop until the model produces an `end_turn` response (or until the iteration cap of 10 is reached as a safety valve).

See [architecture.md](./architecture.md#request-lifecycle) for the step-by-step.

---

## Content block

A **content block** is a single piece of a message. The system uses the same shape the Anthropic SDK does. There are three kinds:

- `text` — plain text (`{ type: "text", text: "..." }`).
- `tool_use` — the model asking to call a tool (`{ type: "tool_use", id, name, input }`).
- `tool_result` — the result of a tool call, sent back as part of a `user`-role message on the next turn (`{ type: "tool_result", tool_use_id, content, is_error? }`).

Messages are stored in DynamoDB with `content` as a JSON-stringified array of content blocks. See [data-model.md](./data-model.md#chat_sessionulid--messageulid).

---

## Source name convention

Wherever a `source` value appears, it is a lowercase snake_case string identifying the channel:

- `discord`
- `email`
- `sms` (planned)
- `voice` (planned)
- `web` (planned)

Pick a short stable value when adding a new channel — it becomes part of DynamoDB keys and cannot be changed casually.
