---
name: Core Service Foundation Architecture
description: Key architectural patterns and decisions established across both the foundation and channel-agnostic refactor
type: project
---

Three-layer config system:
1. `src/config/env.schema.ts` — Zod schema validates all env vars at startup
2. `src/config/configuration.ts` — factory function groups env vars into named domain objects
3. `src/config/env.validation.ts` — safeParse wrapper consumed by `ConfigModule.forRoot({ validate })`
4. Typed config services (`DatabaseConfigService`, `AnthropicConfigService`) wrap `ConfigService` with `getOrThrow`/`get` getters
5. `DynamoDBProvider` uses `useFactory` + `inject: [DatabaseConfigService]` to assemble the client

**Why:** Replicates the established pattern from `ecommerce-app-backend-prod` for consistency across projects.

**How to apply:** When adding new external service integrations, follow this exact layering: Zod schema field → configuration factory key → config service getter → domain service.

**Discord removed (2026-04-30):** `discord.js`, `DiscordService`, `DiscordConfigService`, and `src/types/Discord.ts` were deleted as part of the identity-cleanup Phase 1. Discord was a test harness only; it was never a production channel. Web is now the only channel using IDENTITY records.

## Channel-Agnostic Architecture (post-Discord-removal)

Two-service orchestration for active channels:
- `IdentityService` — maps (source, externalId) → sessionUlid via DynamoDB IDENTITY# records; owns the initial METADATA write. Used by web chat. Email-inbound uses `createSessionWithoutIdentity` instead.
- `ChatSessionService` — purely session-scoped: load history, call Anthropic, persist messages, update metadata. Zero knowledge of web/email/channel

Active channel adapters:
- `WebChatController` — thin HTTP adapter: identity lookup via `lookupOrCreateSession("web", guestUlid, agentName, accountUlid)` → chat core
- `SendgridWebhookController` + `EmailReplyService` — inbound email adapter; uses `createSessionWithoutIdentity` (no IDENTITY records for email)

DynamoDB single-table schema (PK+SK composite required):
- Identity records: PK=SK=`IDENTITY#<source>#<externalId>`, fields: sessionUlid, createdAt
- Message records: PK=`CHAT_SESSION#<sessionUlid>`, SK=`MESSAGE#<ulid>`, fields: role, content, createdAt
- Metadata record: PK=`CHAT_SESSION#<sessionUlid>`, SK=`METADATA`, fields: createdAt, lastMessageAt, source

ULID (not UUID) is the session identifier type — imported from the `ulid` package (in `dependencies`, not `devDependencies`).

Race condition guard on identity creation: `ConditionExpression: "attribute_not_exists(PK)"` on PutCommand; catch via `error.name === "ConditionalCheckFailedException"` (not instanceof — banned pattern). Re-fetch on collision.

`as` type assertions are banned by style guide, but `isConditionalCheckFailed` in identity.service.ts uses `error as { name?: unknown }` — known exception (see review finding).

Metadata UpdateExpression pattern: `SET createdAt = if_not_exists(createdAt, :now), lastMessageAt = :now` — preserves original createdAt.

History query: `ScanIndexForward: false, Limit: 50`, then reverse array in code for chronological order before passing to Anthropic.

Adding a new frontend channel requires only: implement `lookupOrCreateSession("web", userId)` in a new controller/gateway + call `chatSessionService.handleMessage(sessionUlid, content)`. No changes to ChatSessionService.

## KB Pipeline Integrity Architecture (Phase 8d-essential)

- `VoyageDimGuardService` wired from `main.ts` via `app.get()` after `NestFactory.create`, before `app.listen`. Not via `OnModuleInit` — avoids test contamination in `voyage.service.spec.ts`.
- `EXPECTED_VOYAGE_DIMENSION = 1024` exported from `knowledge-base-ingestion.service.ts` — single source of truth for both collection creation and dim guard.
- Deterministic Qdrant point IDs: `generatePointId(accountId, documentId, chunkIndex)` in `src/utils/knowledge-base/qdrant-point-id.ts` via UUIDv5, namespace `KB_POINT_ID_NAMESPACE = "a9d4c8e1-5b7f-4e2a-8c3d-1f6e0b9a2d5c"` — treat as immutable v1 schema commitment.
- `SentryCaptureContext` only supports `tags: Record<string, string>` and `extras`. No native severity field on `captureException` — the brief's `severity: "fatal"` tag is NOT in `SentryCaptureContext`; the implementation omits it (passes only `category` tag). This is a known gap: the brief specifies `tags: { category: "voyage-dim-guard", severity: "fatal" }` but `SentryService.captureException` doesn't set Sentry's event level.
- Per-account isolation: every Qdrant op carries `account_id` filter; `accountId` is part of UUIDv5 name string to prevent cross-account point ID collisions.

## Tool Use Architecture (Phase 1)

Multi-provider DI pattern for tools:
- `CHAT_TOOLS_TOKEN = "CHAT_TOOLS"` injection token in `tool-registry.service.ts`
- Each tool registered via `{ provide: CHAT_TOOLS_TOKEN, useClass: ..., multi: true }` OR via `useFactory` + `inject` if the tool needs NestJS DI (SaveUserFactTool uses useFactory pattern in AppModule — see app.module.ts)
- `ToolRegistryService` receives `@Inject(CHAT_TOOLS_TOKEN) private readonly tools: ChatTool[]`
- Adding a Phase 2 tool: create file, register in AppModule via useFactory — zero changes to ToolRegistryService or ChatSessionService

Tool loop protocol (Anthropic):
- `stop_reason: "tool_use"` → execute all tool_use blocks, build ONE user message with ALL tool_result blocks (tool_results only, no text prefix), append, repeat
- `stop_reason: "end_turn"` → break loop
- `MAX_TOOL_LOOP_ITERATIONS = 10` safeguard
- All new messages (initial user, each assistant, each tool_result user) tracked in `newMessages[]` for bulk DynamoDB persist after loop

DynamoDB content serialization:
- New messages stored as `JSON.stringify(ChatContentBlock[])` in the `content` field
- Legacy plain-string items handled by try/catch around JSON.parse; on failure wrap as `[{ type: "text", text: rawContent }]`

USER_FACT items: `PK=CHAT_SESSION#<sessionUlid>`, `SK=USER_FACT#<key>`, `value=<value>`, `updatedAt` — PutCommand overwrites, no history kept (by design).

Domain type `ChatAnthropicResponse { content: ChatContentBlock[]; stop_reason: string }` lives in `src/types/ChatSession.ts` — bridges AnthropicService and ChatSessionService without coupling to SDK types.
