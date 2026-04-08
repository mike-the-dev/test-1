---
name: Core Service Foundation
description: What was implemented in the initial core service foundation for ai-chat-session-api
type: project
---

The core service foundation is fully implemented and type-checks clean.

**Why:** Initial scaffold only had AppController/AppService. Needed config, DynamoDB, Anthropic, and Discord layers wired before any feature work.

**How to apply:** All config, providers, and services are registered in AppModule. When adding new features, follow the same pattern: config service → provider/SDK wrapper → business logic service → Discord or controller entry point.

Key files created:
- `src/types/ChatSession.ts` — ChatSessionRole, ChatSessionMessage, ChatSessionRecord
- `src/config/env.schema.ts` — Zod schema for all env vars
- `src/config/configuration.ts` — nested config factory (app, database, anthropic, discord domains)
- `src/config/env.validation.ts` — safeParse wrapper passed to ConfigModule
- `src/services/database-config.service.ts` — typed DynamoDB config getters
- `src/services/anthropic-config.service.ts` — typed Anthropic config getters
- `src/services/discord-config.service.ts` — typed Discord config getters
- `src/providers/dynamodb.provider.ts` — DynamoDBDocumentClient useFactory, exports DYNAMO_DB_CLIENT token
- `src/services/anthropic.service.ts` — SDK wrapper, sendMessage returns string
- `src/services/chat-session.service.ts` — orchestrator: DynamoDB history + Anthropic + persist
- `src/services/discord.service.ts` — Discord.js bot, OnModuleInit/OnModuleDestroy
