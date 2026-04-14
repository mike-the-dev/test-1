# Channel: Discord

How Discord messages enter and leave the system.

File: `src/services/discord.service.ts`

---

## What it does

`DiscordService` is a NestJS service with `OnModuleInit` / `OnModuleDestroy` lifecycle hooks. On boot it connects to the Discord gateway using `discord.js` v14; on shutdown it disconnects cleanly.

It listens for two kinds of messages:

1. **Guild messages** via the standard `messageCreate` event listener. Anything that arrives in a server channel the bot is in.
2. **Direct messages** via a **raw gateway packet listener** (`raw` event, filtering for `MESSAGE_CREATE` packets without a `guild_id`). This is a workaround for a bug in `discord.js` v14.26.2 where DM `messageCreate` events do not fire reliably. Listening to the raw packet stream sidesteps it.

Bot messages are always ignored in both paths.

---

## Flow

For every accepted inbound Discord message:

1. Extract `discordUserId`, `channelId`, and `content`.
2. Call `IdentityService.lookupOrCreateSession("discord", discordUserId, "lead_capture")`. This returns a `sessionUlid`, creating a new session on first contact.
3. Call `ChatSessionService.handleMessage(sessionUlid, content)` and `await` the reply string.
4. Send the reply back to Discord:
   - DMs: `user.send(replyText)`.
   - Guild channels: reply to the message in the same channel.

The service does nothing else. No persistence, no prompt assembly, no tool execution — all of that lives in the core.

---

## Required configuration

| Env var | Required | Notes |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Yes (if Discord is enabled) | Bot user token from the Discord developer portal. |
| `DISCORD_GUILD_ID` | Optional | Used to scope the bot to a specific guild for testing. |

Typed access is via `DiscordConfigService` (`src/services/discord-config.service.ts`).

If `DISCORD_BOT_TOKEN` is missing, the service logs a warning and skips the gateway connection. The rest of the app continues to work (e.g. the email reply webhook is unaffected).

---

## Intents and partials

The client is instantiated with:

- **Intents**: `Guilds`, `GuildMessages`, `MessageContent`, `DirectMessages`.
- **Partials**: `Channel`, `Message`, `User`.

`MessageContent` is a [privileged intent](https://discord.com/developers/docs/topics/gateway#privileged-intents) — it must be explicitly enabled in the Discord developer portal for the bot.

`Partials: Channel` is required for DMs because Discord does not send full channel objects for DMs on gateway events — `discord.js` needs to know it is allowed to work with a stub.

---

## Session binding

Every Discord user gets bound to the `lead_capture` agent on first message. This is hard-coded in the service call:

```ts
await this.identityService.lookupOrCreateSession("discord", userId, "lead_capture");
```

If and when you need Discord users to land on a different agent (e.g. a support agent in a specific channel), the branching belongs here — the core doesn't need to know.

---

## Sending replies

Today the service calls `user.send(replyText)` for DMs. Discord enforces a 2000-character limit per message; longer model replies will need chunking. This has not been needed in practice for the `lead_capture` agent, which emits short replies, but it is a known limitation.

---

## Testing locally

1. Create a bot application at https://discord.com/developers/applications.
2. Enable the `MESSAGE CONTENT INTENT` under Bot → Privileged Gateway Intents.
3. Copy the bot token into `.env.local` as `DISCORD_BOT_TOKEN`.
4. Invite the bot to a server you own (or DM it directly).
5. Run `npm run start:local`.
6. Send the bot a DM or mention it in a channel it can see.

The first message will create a new session bound to `lead_capture`. Subsequent messages will continue the same session.

---

## What's out of scope for this channel

- Slash commands. Not implemented — everything is free-form text.
- Voice. Separate future channel (Twilio Voice, not Discord voice).
- Thread support. Messages in threads are handled like any other guild message; there is no thread-specific logic.
- Reactions, embeds, buttons. The service does not emit rich content. It sends plain text.
