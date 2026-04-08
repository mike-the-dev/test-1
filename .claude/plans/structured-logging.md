# Plan: Structured Logging Across Core Services

## Objective

Add NestJS `Logger`-based structured logging to all four core services and bootstrap in `main.ts`. Log levels are gated by `APP_ENV` so local/development runs are verbose (`debug` + `verbose` included) while production only emits `log`, `warn`, and `error`. Message content is never logged anywhere — only metadata such as IDs, counts, lengths, and model names.

---

## Affected Files and Modules

**Modify**
- `src/main.ts` — add logger config to `NestFactory.create` and a bootstrap log after `app.listen`
- `src/services/discord.service.ts` — replace `console.error` with `Logger`; add lifecycle and message-handling log lines
- `src/services/identity.service.ts` — add `Logger`; instrument `lookupOrCreateSession` at debug/log/warn levels
- `src/services/chat-session.service.ts` — add `Logger`; instrument `handleMessage` at debug/log/error levels
- `src/services/anthropic.service.ts` — add `Logger`; instrument `sendMessage` at debug/warn/error levels

**Review Only**
- `src/config/configuration.ts` — confirms `APP_ENV` is available as `process.env.APP_ENV` before the NestJS DI container is ready (relevant for `main.ts` log-level setup)
- `src/app.module.ts` — confirms `ConfigModule` is global but `main.ts` must read `APP_ENV` directly from `process.env` since DI is not yet bootstrapped when `NestFactory.create` options are set

---

## Dependencies and Architectural Considerations

### NestJS Logger import
`Logger` is imported from `@nestjs/common`. The pattern already used in the ecommerce reference codebase is:
```
private readonly logger = new Logger(ServiceName.name);
```
This is the pattern to replicate in all four services.

### Log level config in main.ts
`NestFactory.create` accepts a second options argument. The `logger` key accepts an array of `LogLevel` strings. Because this code runs before the DI container is available, `APP_ENV` must be read directly from `process.env`, not from `ConfigService`. This is correct — `configuration.ts` itself does the same thing with `process.env.APP_ENV`.

```
const isDev = process.env.APP_ENV !== "prod";
const logLevels = isDev
  ? ["log", "warn", "error", "debug", "verbose"]
  : ["log", "warn", "error"];
```

The `LogLevel` type from `@nestjs/common` should be imported to type the array if strict mode requires it. The implementer should check whether TypeScript infers this acceptably or whether an explicit `LogLevel[]` cast is needed — given the project's ban on `as` assertions, prefer importing the `LogLevel` type and annotating the variable.

### Discord ready event — critical architectural note

`client.login(botToken)` returns a Promise that resolves to the bot token string **before the WebSocket gateway connection (READY event) is confirmed**. The Discord.js gateway handshake happens asynchronously after `login()` resolves. This means:

- Logging "Discord client logged in as \<tag\>" inside `await this.client.login(botToken)` would fire before the bot tag is populated on `client.user`.
- The correct pattern is to register a one-time `"ready"` event listener **before** calling `client.login()`. The `ready` event fires when the gateway is fully connected and `client.user` is populated.

Implementation must follow this order in `onModuleInit`:
1. Register the `messageCreate` handler (already done)
2. Register a `client.once("ready", () => { this.logger.log(...) })` handler for the post-login success log
3. Register a `client.once("error", (error) => { this.logger.error(...) })` handler for gateway-level errors
4. Call `await this.client.login(botToken)`

The "logging in" log fires immediately before `client.login(botToken)` is called. The "logged in as \<tag\>" log fires inside the `ready` handler. This is the only safe way to access `client.user.tag`.

### Discord login failure
If `client.login()` throws (invalid token, network failure), the error propagates out of `onModuleInit`. This must be caught with a try/catch wrapping the `client.login()` call so the error can be logged before re-throwing or letting NestJS handle it.

### No business logic changes
All changes are additive log statements only. No service logic, types, or DI wiring changes are needed. The `console.error` in `discord.service.ts` must be replaced, not supplemented, by `this.logger.error` to avoid duplicate output and to comply with the style enforcer checklist ("No `console.log` debug statements").

---

## Step-by-Step Implementation Sequence

### 1. `src/main.ts` — Add logger config and bootstrap log
- **What**: Import `Logger` and `LogLevel` from `@nestjs/common`. Read `APP_ENV` from `process.env`. Build a `logLevels` array. Pass it as `{ logger: logLevels }` to `NestFactory.create`. After `app.listen`, instantiate `new Logger("Bootstrap")` and call `logger.log("Application listening on port X")`.
- **Why first**: Log level config must be set at application creation time, before any service is instantiated. Getting this right first means subsequent service-level logs will only emit at the correct level during testing.
- **Acceptance criteria**: Starting with `APP_ENV=prod npm run start:dev` produces no `debug` or `verbose` output. Starting without `APP_ENV` set (defaults to `local`) produces all log levels. The bootstrap port log appears after the application is ready.

### 2. `src/services/discord.service.ts` — Replace console.error, add Logger
- **What**:
  - Add `import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";`
  - Add `private readonly logger = new Logger(DiscordService.name);` as first class field after `private readonly client`
  - In `onModuleInit`, before `client.login`:
    - Register `client.once("ready", () => { this.logger.log(\`Discord client logged in as \${this.client.user?.tag}\`) })` 
    - Register `client.once("error", (error) => { this.logger.error("Discord gateway error", error) })`
    - Add `this.logger.log("Discord client logging in")` immediately before the `client.login()` call
  - Wrap `client.login()` in try/catch: on catch, `this.logger.error("Discord client login failed", error)` then re-throw
  - In the `messageCreate` handler, after the bot filter returns, add:
    `this.logger.debug(\`Received Discord message [user=${message.author.id} channel=${message.channelId}]\`)`
  - After `await message.reply(reply)`, add:
    `this.logger.log(\`Replied to Discord user [user=${message.author.id} channel=${message.channelId}]\`)`
  - Replace `console.error("Error handling Discord message:", error)` with `this.logger.error(\`Failed to handle Discord message [user=${message.author.id} channel=${message.channelId}]\`, error)`
  - In `onModuleDestroy`, add `this.logger.log("Discord client disconnecting")` before `client.destroy()`
- **Why here**: Discord is the entry point for all messages. Logging here provides the outermost observability envelope. Fixing `console.error` here also clears a style violation.
- **Acceptance criteria**: Boot the app. A Discord message produces four log lines in sequence: received (debug), identity lookup (from step 3, debug), Anthropic call (from step 4, log), replied (log). No message content appears in any log line. Login failure scenario can be tested by setting an invalid `DISCORD_BOT_TOKEN`.

### 3. `src/services/identity.service.ts` — Add Logger
- **What**:
  - Add `import { Injectable, Inject, Logger } from "@nestjs/common";`
  - Add `private readonly logger = new Logger(IdentityService.name);` as first class field
  - At the start of `lookupOrCreateSession`, add:
    `this.logger.debug(\`Looking up identity [source=${source} externalId=${externalId}]\`)`
  - In the `if (existingResult.Item)` branch, before the return, add:
    `this.logger.debug(\`Found existing session [sessionUlid=${sessionUlid} source=${source} externalId=${externalId}]\`)`
  - After `const sessionUlid = ulid()` (the new-session path), add:
    `this.logger.log(\`Creating new session [sessionUlid=${sessionUlid} source=${source} externalId=${externalId}]\`)`
  - In the `isConditionalCheckFailed` recovery branch, before returning `winnerSessionUlid`, add:
    `this.logger.warn(\`Race condition recovered on identity creation [source=${source} externalId=${externalId} sessionUlid=${winnerSessionUlid}]\`)`
- **Why here**: Identity lookup is the second hop in the message flow. Race condition recovery is a notable operational event that warrants a warn-level log to surface in production.
- **Acceptance criteria**: First message from a Discord user produces the "Creating new session" log line (log level). Subsequent messages from the same user produce only the "Found existing session" line (debug, invisible in prod). Concurrent writes produce a warn line.

### 4. `src/services/chat-session.service.ts` — Add Logger
- **What**:
  - Add `import { Injectable, Inject, Logger } from "@nestjs/common";`
  - Add `private readonly logger = new Logger(ChatSessionService.name);` as first class field
  - At the start of `handleMessage`:
    `this.logger.debug(\`Handling message for session [sessionUlid=${sessionUlid}]\`)`
  - After `const items = historyResult.Items ?? []`:
    `this.logger.debug(\`Loaded ${items.length} messages from history [sessionUlid=${sessionUlid}]\`)`
  - Before `await this.anthropicService.sendMessage(history)`:
    `this.logger.log(\`Calling Anthropic [sessionUlid=${sessionUlid} historySize=${history.length}]\`)`
  - After `const reply = await this.anthropicService.sendMessage(history)`:
    `this.logger.debug(\`Anthropic responded [sessionUlid=${sessionUlid} responseLength=${reply.length}]\`)`
  - After both PutCommand calls and the UpdateCommand (after the metadata update):
    `this.logger.log(\`Stored user and assistant messages [sessionUlid=${sessionUlid}]\`)`
  - Wrap the entire function body in try/catch (or add a catch block if the current code does not have one — it does not). In catch: `this.logger.error(\`Failed to handle message for session [sessionUlid=${sessionUlid}]\`, error)` then re-throw.
  - **NEVER log `userMessage` or `reply` variables.**
- **Why here**: Chat session is where the core business logic runs. The "Calling Anthropic" log at `log` level will be visible in production and provides a latency anchor point.
- **Acceptance criteria**: Each inbound message produces a predictable sequence of log lines. `responseLength` is a character count of the reply — not the reply itself. No message text appears in any log.

### 5. `src/services/anthropic.service.ts` — Add Logger
- **What**:
  - Add `import { Injectable, Logger } from "@nestjs/common";`
  - Add `private readonly logger = new Logger(AnthropicService.name);` as first class field
  - At the start of `sendMessage`:
    `this.logger.debug(\`Sending ${messages.length} messages to Anthropic [model=${this.anthropicConfig.model}]\`)`
  - In the `if (firstBlock.type !== "text")` branch, before throwing:
    `this.logger.warn(\`Anthropic returned non-text response [type=${firstBlock.type}]\`)`
  - Wrap the `this.client.messages.create(...)` call in try/catch. In catch: `this.logger.error("Anthropic API call failed", error)` then re-throw.
  - **NEVER log `messages` contents or `firstBlock.text`.**
- **Why last**: `AnthropicService` is the deepest dependency. Implementing it last means the full log chain can be traced end-to-end from step 2 onward once all prior steps are in place.
- **Acceptance criteria**: Each Anthropic call produces one debug line showing message count and model name. A non-text response (rare, but testable with a mock) produces a warn. An API error produces an error log and propagates up to `ChatSessionService`'s catch block, producing a second error log there with the session context.

---

## Risks and Edge Cases

**High**
- **Discord login fires "logged in" before `client.user` is populated** if the ready event pattern is not followed. Accessing `this.client.user?.tag` outside the `ready` handler will produce `undefined`. Mitigation: use `client.once("ready", ...)` as specified in step 2. The optional chaining `?.tag` is a fallback — prefer the ready handler structure where it cannot be undefined.
- **`client.login()` is not wrapped in try/catch in the current code.** A failed login (bad token, network error) currently causes an unhandled rejection that kills `onModuleInit` silently at the NestJS level. Adding a try/catch around `client.login()` is required both for logging and for correctness. Re-throw after logging so NestJS can handle the lifecycle failure normally.

**Medium**
- **`chat-session.service.ts` has no try/catch today.** Adding one introduces a new code path. The implementer must ensure the catch block re-throws the error after logging — do not swallow errors. The Discord service already has a catch block that handles user-facing recovery (sending "Sorry" reply), so any error re-thrown from `handleMessage` is caught there and does not surface to the user as an unhandled exception.
- **`anthropic.service.ts` has no try/catch today.** Same concern — add catch, log, re-throw. Do not swallow.
- **Log level type safety.** The `logger` option in `NestFactory.create` expects `LogLevel[]`. TypeScript strict mode may reject a plain `string[]`. Import `LogLevel` from `@nestjs/common` and annotate the variable accordingly, rather than using an `as` assertion (which is banned).

**Low**
- **`externalId` in identity logs.** For Discord this is a numeric user ID (snowflake), not a name or sensitive identifier — safe to log. If other sources are added in the future, this assumption should be revisited per-source.
- **`message.channelId` in Discord logs.** Channel IDs are non-sensitive Discord snowflakes. Safe to log.
- **`reply.length` in chat-session logs.** This logs character count only — not the reply text. This is safe.

---

## Testing Strategy

### Manual verification (primary)
Boot the app locally against a real Discord bot token:

```
npm run start:dev
```

Expected startup output:
```
[Bootstrap] Application listening on port 3000
[DiscordService] Discord client logging in
[DiscordService] Discord client logged in as <BotName>#0000
```

Send a message from a new Discord user. Expected log sequence (with `APP_ENV` unset or `local`):
```
[DiscordService] [debug] Received Discord message [user=<id> channel=<id>]
[IdentityService] [debug] Looking up identity [source=discord externalId=<id>]
[IdentityService] [log]   Creating new session [sessionUlid=<ulid>]
[ChatSessionService] [debug] Handling message for session [sessionUlid=<ulid>]
[ChatSessionService] [debug] Loaded 0 messages from history [sessionUlid=<ulid>]
[AnthropicService]  [debug] Sending 1 messages to Anthropic [model=claude-opus-4-6]
[ChatSessionService] [log]  Calling Anthropic [sessionUlid=<ulid> historySize=1]
[AnthropicService]  [debug] (no line here — response comes back)
[ChatSessionService] [debug] Anthropic responded [sessionUlid=<ulid> responseLength=<n>]
[ChatSessionService] [log]  Stored user and assistant messages [sessionUlid=<ulid>]
[DiscordService]    [log]   Replied to Discord user [user=<id> channel=<id>]
```

Send a second message from the same user. Expected identity log change:
```
[IdentityService] [debug] Found existing session [sessionUlid=<ulid> source=discord externalId=<id>]
```
(No "Creating new session" line.)

### Production log level verification
Set `APP_ENV=prod` and restart. Confirm that only `log`, `warn`, and `error` lines appear. The `debug` lines (received message, loaded history, Anthropic responded, handling message, etc.) must be absent. The `log` lines (Creating new session, Calling Anthropic, Stored messages, Replied) must still appear.

### Error path verification
Set `DISCORD_BOT_TOKEN` to an invalid value. Expected:
```
[DiscordService] [error] Discord client login failed  <error object>
```
Application should fail to start (or the module init should throw). Verify no unhandled rejection crash without a log line.

### Unit tests
No new unit tests are strictly required for this change since all additions are log calls with no logic. The existing test suite should continue to pass without modification. If any existing tests assert on `console.error`, they will need updating to mock `Logger.prototype.error` instead — check with `npm test` after implementation.

---

## Implementation Recommendations

- Follow the exact class field declaration pattern from the ecommerce reference: `private readonly logger = new Logger(ServiceName.name)` placed as the **first** class field, before `private readonly client` or any other field. This matches the ecommerce `StripeService` layout.
- The `Logger` import replaces no existing imports — it is additive to the `@nestjs/common` import in each file. Update each file's existing `@nestjs/common` import line rather than adding a second import statement.
- In `main.ts`, the bootstrap logger is a standalone `new Logger("Bootstrap")` local variable, not a class field — matching the ecommerce `main.ts` pattern of `new Logger("CorsOriginResolver")`.
- Log format for structured fields: use square brackets with `key=value` pairs inline in the message string (e.g., `[sessionUlid=${sessionUlid} historySize=${history.length}]`). This is consistent, greppable, and readable without requiring a JSON logger.
- Do not introduce a log line inside the Discord `messageCreate` handler for the bot-author early return. Logging filtered bot messages would produce excessive noise. The filter should remain silent.
- The `client.once("error", ...)` gateway error handler is a separate concern from the login try/catch. The gateway error event can fire after successful login (e.g., during reconnection). Both are needed.
