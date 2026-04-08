---
name: Core Service Foundation Architecture
description: Key architectural patterns and decisions established across both the foundation and channel-agnostic refactor
type: project
---

Three-layer config system:
1. `src/config/env.schema.ts` — Zod schema validates all env vars at startup
2. `src/config/configuration.ts` — factory function groups env vars into named domain objects
3. `src/config/env.validation.ts` — safeParse wrapper consumed by `ConfigModule.forRoot({ validate })`
4. Typed config services (`DatabaseConfigService`, `AnthropicConfigService`, `DiscordConfigService`) wrap `ConfigService` with `getOrThrow`/`get` getters
5. `DynamoDBProvider` uses `useFactory` + `inject: [DatabaseConfigService]` to assemble the client

**Why:** Replicates the established pattern from `ecommerce-app-backend-prod` for consistency across projects.

**How to apply:** When adding new external service integrations, follow this exact layering: Zod schema field → configuration factory key → config service getter → domain service.

Discord.js is the sole entry point for chat flow — no HTTP controllers for `ChatSessionService`. `DiscordService` implements `OnModuleInit` and `OnModuleDestroy`, calls `client.login()` in `onModuleInit` (not constructor), and guards against missing bot token for local dev.

## Channel-Agnostic Architecture (post-refactor)

Three-service orchestration:
- `IdentityService` — maps (source, externalId) → sessionUlid via DynamoDB IDENTITY# records; owns the initial METADATA write
- `ChatSessionService` — purely session-scoped: load history, call Anthropic, persist messages, update metadata. Zero knowledge of Discord/web/users
- `DiscordService` — thin adapter: identity lookup → chat session call → message.reply(). No DynamoDB, no Anthropic

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
