---
name: Project Architecture Overview
description: Discord-only entry point, DynamoDB single-item-per-session history, Anthropic SDK wrapped in service
type: project
---

Three transport layers exist: `DiscordService` (messageCreate events), `SendgridWebhookController`
(`POST /webhooks/sendgrid/inbound`), and `WebChatController` (`POST /chat/web/sessions` and
`POST /chat/web/messages`, M0). All delegate to `ChatSessionService.handleMessage(sessionUlid, text)`
and ship the result back over the originating channel. Adding a fourth transport means a new
controller + service that calls `ChatSessionService` — no other files need changing.

**M0 web chat additions:** `OriginAllowlistService` performs GSI1 Query (`KeyConditionExpression =
"GSI1PK = :pk"`, `:pk = "DOMAIN#<host>"`) against the same DynamoDB table to check whether an
Origin is an allowed client domain. Reuses `DYNAMO_DB_CLIENT` provider. In-memory TTL cache
(`Map<string, { allowed: boolean; expiresAt: number }>`) — 5 min positive, 1 min negative.
Dynamic CORS wired in `main.ts` via `app.get(OriginAllowlistService)` before `app.enableCors()`.
`AgentRegistryService.getByName()` returns `null` for unknown agents (not an exception).

**Phase 4 email reply loop:** Outbound emails use `<sessionUlid>@<replyDomain>` as `From:`.
Replies route back via DNS MX → SendGrid Inbound Parse → webhook. `EmailReplyService` handles
all inbound logic: ULID extraction, idempotency (DynamoDB conditional PutCommand on
`EMAIL_INBOUND#<messageId>` / `METADATA`), sender validation against `USER_CONTACT_INFO`,
quoted-reply stripping, dispatch to `ChatSessionService`, and outbound reply via `EmailService`.

Config system: Zod env schema (`src/config/env.schema.ts`) → configuration factory
(`src/config/configuration.ts`) → typed config services (one per domain: DatabaseConfigService,
AnthropicConfigService, DiscordConfigService) → providers.

**Planned DynamoDB data model (channel-agnostic refactor):** Single-table design with composite
PK (String) + SK (String) keys. Three item types:
- `IDENTITY#<source>#<externalId>` / `IDENTITY#<source>#<externalId>` — maps external IDs to session ULIDs
- `CHAT_SESSION#<sessionUlid>` / `MESSAGE#<messageUlid>` — one item per message
- `CHAT_SESSION#<sessionUlid>` / `METADATA` — session metadata

**DynamoDB USER_FACT items (added in Phase 1 tool use):** `CHAT_SESSION#<sessionUlid>` / `USER_FACT#<key>` — key-value facts about the user saved by the `save_user_fact` tool. PutCommand overwrites on same key (facts are updatable by design).

**Previous DynamoDB model (pre-refactor):** Single item per session keyed by `sessionId`
(partition key only, no SK), containing a `messages` array. Table must be recreated with
PK+SK composite keys before the refactor can be tested.

**Why:** This project is a Discord bot that uses Anthropic Claude as its AI backend. The
decision to use Discord as the entry point (not HTTP) drives the entire service topology.
The channel-agnostic refactor decouples Discord from session identity so other frontends
(web, Slack, etc.) can share the same session infrastructure.

**USER_CONTACT_INFO record shape (verified from collect-contact-info.tool.ts):**
`PK: CHAT_SESSION#<sessionUlid>` / `SK: USER_CONTACT_INFO`. Attributes stored with full
camelCase names: `firstName`, `lastName`, `email`, `phone`, `company`, `updatedAt`, `createdAt`.
The two-letter aliases (`fn`, `em`, etc.) are DynamoDB expression aliases only — not stored names.

**How to apply:** When planning new features, check which transport they arrive on and model
the controller/service after the Discord or email transport-layer pattern. All session DB access
goes through `ChatSessionService` (history) and `IdentityService` (external ID → ULID). The
`isConditionalCheckFailed` helper pattern lives in both `identity.service.ts` and
`email-reply.service.ts` — mirror it exactly (including the local `as` cast) when writing new
DynamoDB conditional-check code.
