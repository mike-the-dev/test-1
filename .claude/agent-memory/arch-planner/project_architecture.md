---
name: Project Architecture Overview
description: Core architecture of ai-chat-session-api — NestJS Discord bot backed by DynamoDB and Anthropic, no HTTP entry points for chat flow
type: project
---

Discord.js is the sole entry point (not HTTP). `DiscordService` listens for `messageCreate`
events and delegates to `ChatSessionService`, which loads conversation history from DynamoDB,
calls Anthropic, and persists messages. No controllers are needed for the chat flow.

Config system: Zod env schema (`src/config/env.schema.ts`) → configuration factory
(`src/config/configuration.ts`) → typed config services (one per domain: DatabaseConfigService,
AnthropicConfigService, DiscordConfigService) → providers.

**Planned DynamoDB data model (channel-agnostic refactor):** Single-table design with composite
PK (String) + SK (String) keys. Three item types:
- `IDENTITY#<source>#<externalId>` / `IDENTITY#<source>#<externalId>` — maps external IDs to session ULIDs
- `CHAT_SESSION#<sessionUlid>` / `MESSAGE#<messageUlid>` — one item per message
- `CHAT_SESSION#<sessionUlid>` / `METADATA` — session metadata

**Previous DynamoDB model (pre-refactor):** Single item per session keyed by `sessionId`
(partition key only, no SK), containing a `messages` array. Table must be recreated with
PK+SK composite keys before the refactor can be tested.

**Why:** This project is a Discord bot that uses Anthropic Claude as its AI backend. The
decision to use Discord as the entry point (not HTTP) drives the entire service topology.
The channel-agnostic refactor decouples Discord from session identity so other frontends
(web, Slack, etc.) can share the same session infrastructure.

**How to apply:** When planning new features, check whether they are Discord-triggered or
require a new HTTP surface. The current architecture has no HTTP controllers for chat — adding
one would be an intentional architectural expansion, not the default. All new session-related
DB access must go through IdentityService (for external ID → ULID mapping) and ChatSessionService
(for history read/write) — never direct DynamoDB calls from channel adapters.
