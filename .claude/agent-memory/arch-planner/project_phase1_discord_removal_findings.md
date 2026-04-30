---
name: Phase 1 Discord removal — codebase findings
description: Exact Discord footprint found during arch-planning for the Discord removal phase (Phase 1 of identity cleanup)
type: project
---

Discord removal scope confirmed by reading the actual files:

**Files to DELETE (4 source files + 1 type file):**
- `src/services/discord.service.ts` — the gateway adapter; calls `identityService.lookupOrCreateSession("discord", ...)` and `chatSessionService.handleMessage()`
- `src/services/discord-config.service.ts` — NestJS provider with `botToken` and `guildId` getters; reads `discord.*` config keys
- `src/services/discord.service.spec.ts` — does NOT exist (confirmed)
- `src/services/discord-config.service.spec.ts` — does NOT exist (confirmed)
- `src/types/Discord.ts` — defines only `RawGatewayPacket` interface; used solely by `discord.service.ts`
- `docs/reference/channels/discord.md` — the Discord channel reference doc

**Files to EDIT:**
- `src/app.module.ts` — remove `DiscordConfigService` and `DiscordService` from imports and providers array (both currently registered as flat providers, not in a sub-module)
- `src/config/configuration.ts` — remove the `discord:` block (`botToken`, `guildId`)
- `src/config/env.schema.ts` — remove `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID` from Zod schema
- `src/services/identity.service.spec.ts` — all `lookupOrCreateSession` tests use `"discord"` as the source string; the tests pass `source` as a generic string param so "discord" is just test data. Tests STAY but the string literals can optionally be changed to `"web"` for clarity (not strictly required since `source` is `string` typed)
- `docs/reference/architecture.md` — remove `DiscordService` from the layered diagram and request lifecycle steps; update "channel adapters" description to remove Discord references
- `docs/reference/concepts.md` — remove `discord` row from the identity source table; update the channels-today list to remove the Discord bullet and link
- `docs/reference/channels/email.md` — line 20 says "the same conversation can start on Discord, finish on email, or vice versa" — update this sentence to remove Discord reference
- `docs/reference/data-model.md` — the identity record table example uses `discord` as a source value; update to `web` or `email`

**No Discord controller exists** — Discord is wired via OnModuleInit in discord.service.ts (a gateway, not HTTP controller). No separate Discord controller file.

**No separate Discord NestJS module** — everything is flat-registered in AppModule. The two providers to remove are `DiscordConfigService` and `DiscordService` from the `providers: [...]` array, plus their two import statements at the top of app.module.ts.

**Env vars to remove:** `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` — both optional in the current schema so startup is not blocked if missing. After removal they simply do not exist in the schema.

**npm package to remove:** `discord.js` from `dependencies` in `package.json`. No other Discord-only npm packages found. `uuid` and other deps are used elsewhere and stay.

**SENDGRID_REPLY_ACCOUNT_ID** is NOT in env.schema.ts despite being in configuration.ts and sendgrid-config.service.ts — this is a pre-existing gap (not introduced by this phase; do not touch it).

**Operational alert path:** Confirmed as Slack only (`slack-alert.service.ts` posts to Slack webhook). No Discord webhook operational notification code exists anywhere in the repo. Nothing in-scope to preserve.

**identity.service.spec.ts Discord usage:** All `lookupOrCreateSession` tests pass `"discord"` as the source argument — this is purely test fixture data, not a branch on `source === "discord"`. The `source` param is typed `string`; the service has zero conditional logic on the source value. Test strings can optionally be updated to `"web"` for clarity but the tests will remain valid as-is (the string is round-tripped to DynamoDB mock expectations that also say "discord").

**Existing DynamoDB records:** `IDENTITY#discord#*` records and possibly `CHAT_SESSION` METADATA records with `source: "discord"` exist in dev/test environment. Application not in production. Plan recommends leaving them orphaned — cheap and harmless for dev/test data.

**Why:** Discord was originally added as a test harness. It is not part of the production product. Removing it clears the path for Phase 2 (IDENTITY pattern simplification), since after removal web is the only remaining IDENTITY writer.
