# Plan: Core Service Foundation

## Objective

Stand up the config, provider, and service layers for DynamoDB, Anthropic (Claude API), and
Discord.js in a fresh NestJS 11 project. The architecture mirrors the three-layer config system
from the ecommerce backend: a Zod env schema validates at startup, a configuration factory
groups env vars into named domains, typed config services wrap `ConfigService` with `getOrThrow`
getters, and a `useFactory` provider assembles the DynamoDB client from the config service.
Discord.js is the sole entry point — there are no HTTP controllers for the chat flow. The
chat-session service is the orchestrator: Discord fires an event, the service loads conversation
history from DynamoDB, calls Anthropic, and persists the updated history.

---

## Required Package Installations

Before any files are written, the following packages must be installed. None are present in the
current `package.json`.

```
npm install @nestjs/config @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @anthropic-ai/sdk discord.js zod
```

- `@nestjs/config` — `ConfigModule` and `ConfigService`
- `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` — `DynamoDBClient` and `DynamoDBDocumentClient`
- `@anthropic-ai/sdk` — official Anthropic SDK
- `discord.js` — Discord bot client
- `zod` — env validation schema

---

## Affected Files and Modules

### Create (new files)

| File | Purpose |
|---|---|
| `src/config/env.schema.ts` | Zod schema for all env vars |
| `src/config/configuration.ts` | Factory function grouping config by domain |
| `src/config/env.validation.ts` | Zod `safeParse` wrapper consumed by `ConfigModule` |
| `src/types/ChatSession.ts` | All types for messages, session records, Anthropic roles |
| `src/services/database-config.service.ts` | Typed getters for DynamoDB config keys |
| `src/services/anthropic-config.service.ts` | Typed getters for Anthropic config keys |
| `src/services/discord-config.service.ts` | Typed getters for Discord config keys |
| `src/providers/dynamodb.provider.ts` | `useFactory` provider producing `DynamoDBDocumentClient` |
| `src/services/anthropic.service.ts` | Wraps Anthropic SDK; accepts message array, returns string reply |
| `src/services/discord.service.ts` | Wraps `discord.js` Client; listens for `messageCreate`, calls `ChatSessionService` |
| `src/services/chat-session.service.ts` | Orchestrator: loads DynamoDB history, calls Anthropic, persists result |

### Modify (existing files)

| File | Reason |
|---|---|
| `src/app.module.ts` | Wire `ConfigModule`, all providers and services into the module |
| `package.json` | Add the five packages listed above |

### Review Only (no changes)

| File | Reason |
|---|---|
| `src/app.controller.ts` | Remains as scaffold default; no chat flow HTTP controller needed |
| `src/app.service.ts` | Remains as scaffold default |
| `tsconfig.json` | Already configured correctly for NestJS 11 (`emitDecoratorMetadata`, `experimentalDecorators`) |

---

## Dependencies and Architectural Considerations

### Module / DI wiring
`ConfigModule.forRoot` must be declared `isGlobal: true` in `AppModule`. This makes
`ConfigService` injectable everywhere without per-module re-imports. All three config services
(`DatabaseConfigService`, `AnthropicConfigService`, `DiscordConfigService`) and `DynamoDBProvider`
must be registered in `AppModule.providers`. `ChatSessionService` depends on `DynamoDBDocumentClient`
(injected via the `DYNAMO_DB_CLIENT` token) and `AnthropicService`. `DiscordService` depends on
`ChatSessionService` and `DiscordConfigService`.

### Injection token
`DynamoDBProvider` uses a string injection token (`"DYNAMO_DB_CLIENT"`). `ChatSessionService`
must use `@Inject("DYNAMO_DB_CLIENT")` on its constructor parameter. Export the token constant
from `dynamodb.provider.ts` so both files reference the same string.

### Discord.js lifecycle
`DiscordService` must implement `OnModuleInit` (from `@nestjs/common`) so the Discord client
logs in and attaches event listeners after the NestJS DI container is ready. Do not call
`client.login()` in the constructor — the `ConfigService` may not be available yet.

### DynamoDB data model
Each chat session is stored as a single DynamoDB item keyed by `sessionId`. The item contains
the `sessionId` (partition key) and a `messages` attribute that is an array of message objects.
This means each `GetCommand` retrieves the full conversation history, and each `PutCommand`
overwrites the entire item with the updated array. This is appropriate for conversations that
remain bounded in size; it avoids the complexity of sparse indexing.

### Anthropic message format
The Anthropic SDK `messages.create` call expects an array of `{ role: "user" | "assistant", content: string }`
objects. The `ChatSessionMessage` type in `src/types/ChatSession.ts` should match this shape
exactly so it can be passed directly to the SDK without transformation.

### Local dev with no credentials
`ANTHROPIC_API_KEY`, `DISCORD_BOT_TOKEN`, and `DISCORD_GUILD_ID` should be `.optional()` in
the Zod schema. `DYNAMODB_ENDPOINT` should default to `"http://localhost:8000"` in the
configuration factory when `APP_ENV` is `"local"` so a local DynamoDB (e.g., Docker) works
without credentials. The `DatabaseConfigService.endpoint` getter should return `string | undefined`,
matching the ecommerce backend pattern.

### tsconfig `module: nodenext`
The project uses `"module": "nodenext"`. All imports within the project must use explicit `.js`
extensions on relative imports OR rely on NestJS/ts-node's module resolution. The ecommerce
backend uses `"module": "commonjs"` so this is a divergence. When writing import statements,
omit file extensions (ts-node handles resolution at runtime) but be aware this may need
adjustment if `tsc` strict ESM output is ever targeted.

---

## Step-by-Step Implementation Sequence

```
1. [package.json] Install required packages
   - npm install @nestjs/config @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @anthropic-ai/sdk discord.js zod
   - Why first: Every subsequent file imports from these packages; TypeScript will fail to
     compile without them present in node_modules and their types available.
   - Done when: `package.json` lists all five packages under `dependencies` and
     `node_modules` contains them.

2. [src/types/ChatSession.ts] Define all domain types
   - Define `ChatSessionRole` as a string union type: `"user" | "assistant"`
   - Define `ChatSessionMessage` interface: `{ role: ChatSessionRole; content: string }`
   - Define `ChatSessionRecord` interface: `{ sessionId: string; messages: ChatSessionMessage[] }`
   - Why second: All downstream services and config services import from this file. TypeScript
     compilation order requires types to exist before their consumers.
   - Done when: `npx tsc --noEmit` passes on this file in isolation.

3. [src/config/env.schema.ts] Define Zod env schema
   - Export `envSchema` using `z.object({ ... })`
   - Required fields (`.string().min(1)`): `DYNAMODB_REGION`, `DYNAMODB_TABLE_CONVERSATIONS`
   - Optional fields (`.string().optional()`): `DYNAMODB_ENDPOINT`, `ANTHROPIC_API_KEY`,
     `ANTHROPIC_MODEL`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`
   - Fields with defaults: `APP_ENV` (`.enum(["local","staging","prod"]).default("local")`),
     `PORT` (`.coerce.number().default(3000)`)
   - Export `Env` type: `export type Env = z.infer<typeof envSchema>`
   - Why third: `env.validation.ts` imports this schema; nothing else in the chain works
     without it.
   - Done when: File compiles, schema parses a minimal valid object without throwing.

4. [src/config/configuration.ts] Define configuration factory
   - Export default `configuration` arrow function that reads from `process.env` and returns
     a nested object with four domain keys:
     - `app`: `{ env, port }`
     - `database`: `{ region, endpoint, conversationsTable }` — endpoint defaults to
       `"http://localhost:8000"` when `APP_ENV` is `"local"`, otherwise `undefined`
     - `anthropic`: `{ apiKey, model }` — model defaults to `"claude-opus-4-5"` when not set
     - `discord`: `{ botToken, guildId }`
   - Why fourth: `AppModule` passes this factory to `ConfigModule.forRoot({ load: [configuration] })`.
     The typed config services rely on the key paths established here (e.g., `"database.region"`).
   - Done when: File compiles; manual inspection confirms key paths match what the config
     services will call.

5. [src/config/env.validation.ts] Define Zod safeParse wrapper
   - Export `validate` function that accepts `Record<string, unknown>`, calls
     `envSchema.safeParse(config)`, logs `result.error.format()` on failure, and throws
     `new Error("Config validation failed")`.
   - Pattern is identical to the ecommerce backend.
   - Why fifth: `AppModule` passes this as the `validate` option to `ConfigModule.forRoot`.
     It must exist before `AppModule` is written.
   - Done when: File compiles cleanly.

6. [src/services/database-config.service.ts] Typed DynamoDB config getters
   - `@Injectable()` class wrapping `ConfigService`
   - `get region(): string` — `configService.getOrThrow<string>("database.region", { infer: true })`
   - `get endpoint(): string | undefined` — `configService.get<string>("database.endpoint", { infer: true })`
   - `get conversationsTable(): string` — `configService.getOrThrow<string>("database.conversationsTable", { infer: true })`
   - Why sixth: `DynamoDBProvider` depends on this service via `inject: [DatabaseConfigService]`.
     Must exist before the provider is defined.
   - Done when: File compiles; constructor injection of `ConfigService` is correctly typed.

7. [src/services/anthropic-config.service.ts] Typed Anthropic config getters
   - `@Injectable()` class wrapping `ConfigService`
   - `get apiKey(): string | undefined` — `configService.get<string>("anthropic.apiKey", { infer: true })`
   - `get model(): string` — `configService.getOrThrow<string>("anthropic.model", { infer: true })`
   - Why seventh: `AnthropicService` depends on this; sequencing with config services first
     keeps the dependency chain clean.
   - Done when: File compiles cleanly.

8. [src/services/discord-config.service.ts] Typed Discord config getters
   - `@Injectable()` class wrapping `ConfigService`
   - `get botToken(): string | undefined` — `configService.get<string>("discord.botToken", { infer: true })`
   - `get guildId(): string | undefined` — `configService.get<string>("discord.guildId", { infer: true })`
   - Why eighth: `DiscordService` depends on this; follows the same pattern as the other
     two config services.
   - Done when: File compiles cleanly.

9. [src/providers/dynamodb.provider.ts] DynamoDBDocumentClient factory provider
   - Export string constant `DYNAMO_DB_CLIENT = "DYNAMO_DB_CLIENT"`
   - Export `DynamoDBProvider` object with `provide`, `useFactory`, and `inject` fields
   - `useFactory` receives `DatabaseConfigService`, constructs `new DynamoDBClient({ region, endpoint })`
   - Wraps with `DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } })`
   - Pattern is identical to the ecommerce backend.
   - Why ninth: `ChatSessionService` injects this client; it must be defined before that
     service is written.
   - Done when: File compiles; `DatabaseConfigService` import resolves correctly.

10. [src/services/anthropic.service.ts] Anthropic SDK wrapper
    - `@Injectable()` class
    - Constructor receives `AnthropicConfigService`
    - On construction, instantiate `new Anthropic({ apiKey: this.anthropicConfig.apiKey })`
      and store as a private field (not injected — the SDK client is created imperatively
      since it is not a NestJS provider)
    - Expose one public async method: `sendMessage(messages: ChatSessionMessage[]): Promise<string>`
      - Calls `this.anthropic.messages.create({ model, max_tokens, messages })`
      - Extracts the text content from the first content block and returns it as a string
      - `max_tokens` should be a reasonable default (e.g., 1024); consider making it
        configurable later
    - Import `ChatSessionMessage` from `src/types/ChatSession.ts`
    - Why tenth: `ChatSessionService` depends on this; must exist before the orchestrator.
    - Done when: File compiles; method signature accepts `ChatSessionMessage[]` and returns
      `Promise<string>`.

11. [src/services/chat-session.service.ts] Orchestrator service
    - `@Injectable()` class
    - Constructor injects `@Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient`
      and `private readonly anthropicService: AnthropicService` and
      `private readonly databaseConfig: DatabaseConfigService`
    - Expose one public async method:
      `handleMessage(sessionId: string, userMessage: string): Promise<string>`
      1. Load existing session via `GetCommand` — `Key: { sessionId }`, table from
         `databaseConfig.conversationsTable`
      2. Extract `messages` array from the item, or initialize to `[]` if not found
      3. Append `{ role: "user", content: userMessage }` to the array
      4. Call `anthropicService.sendMessage(messages)` to get the assistant reply
      5. Append `{ role: "assistant", content: reply }` to the array
      6. Persist updated array via `PutCommand` — `Item: { sessionId, messages }`, same table
      7. Return the reply string
    - All types (`ChatSessionMessage`, `ChatSessionRecord`) imported from `src/types/ChatSession.ts`
    - Why eleventh: Depends on both `DynamoDBDocumentClient` (step 9) and `AnthropicService`
      (step 10).
    - Done when: File compiles; method signature is correct; DI token import resolves.

12. [src/services/discord.service.ts] Discord.js event gateway service
    - `@Injectable()` class implementing `OnModuleInit` from `@nestjs/common`
    - Constructor receives `DiscordConfigService` and `ChatSessionService`
    - Create a private `client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] })`
      as a field (instantiated in constructor, not via DI)
    - `onModuleInit()` method:
      1. Attach `client.on("messageCreate", ...)` listener
      2. In the listener: guard against bot messages (`message.author.bot`), extract
         `sessionId` from `message.channelId`, call `chatSessionService.handleMessage(sessionId, message.content)`
      3. Reply with the returned string using `message.reply(reply)`
      4. Call `client.login(this.discordConfig.botToken)` — guards against missing token for
         local dev (skip login if token is undefined)
    - Why twelfth: Depends on `ChatSessionService` (step 11) and `DiscordConfigService` (step 8).
      This is the topmost layer and the runtime entry point for all chat traffic.
    - Done when: File compiles; `onModuleInit` signature is correct; bot token guard is present.

13. [src/app.module.ts] Wire everything together
    - Add `ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate })` to `imports`
    - Add to `providers`:
      - `DatabaseConfigService`
      - `AnthropicConfigService`
      - `DiscordConfigService`
      - `DynamoDBProvider` (the `useFactory` object, not a class)
      - `AnthropicService`
      - `ChatSessionService`
      - `DiscordService`
    - Keep existing `AppController` and `AppService` (scaffold default — do not remove)
    - Why last: All dependencies must exist before the module can reference them. Writing
      this last ensures no circular or missing import errors.
    - Done when: `npx tsc --noEmit` passes; `npm run start:dev` starts without throwing a
      DI resolution error.
```

---

## Risks and Edge Cases

**High — Discord `MessageContent` privileged intent**
Discord requires the `MESSAGE_CONTENT` privileged intent to be enabled in the Discord Developer
Portal for the bot application, in addition to being declared in the client constructor. If it is
not enabled in the portal, `message.content` will always be an empty string. This is a runtime
misconfiguration that TypeScript cannot catch.
Mitigation: Document this in a `.env.example` file and add a startup guard in `DiscordService.onModuleInit`
that logs a clear warning if `DISCORD_BOT_TOKEN` is present but `message.content` appears empty
on the first event.

**High — Anthropic response shape assumption**
The plan assumes `response.content[0]` is a `text` block and accesses `.text` on it. The Anthropic
SDK can return `tool_use` blocks or other content types. Accessing `.text` on a non-text block at
runtime will throw.
Mitigation: In `AnthropicService.sendMessage`, check `response.content[0].type === "text"` and
throw a descriptive error if it is not. Given the style rules ban `typeof` checks for union
discrimination — this is a property access check (`=== "text"`), which is allowed.

**High — `module: nodenext` relative import extensions**
The tsconfig uses `"module": "nodenext"`. Under strict ESM, TypeScript requires `.js` extensions
on relative imports even when source files are `.ts`. However, `ts-node` and the NestJS CLI
typically handle this transparently in dev/build mode. If compilation begins failing with
"cannot find module" errors on relative imports, all relative imports will need `.js` suffixes.
Mitigation: Watch the first `npm run build` output carefully; if extension errors appear, a
codemod-style find-and-replace across all new files resolves it quickly.

**Medium — DynamoDB single-item overwrite on concurrent sessions**
The `PutCommand` overwrites the entire item. If two Discord messages arrive for the same
`sessionId` within the same millisecond (e.g., a bot replying rapidly), the second read will
see stale history and overwrite the first write's result.
Mitigation: This is acceptable for a chat bot where messages are user-driven and sequential.
If concurrency becomes a concern later, switch to a DynamoDB conditional write with a version
attribute or use a list-append expression.

**Medium — Unbounded conversation history**
Appending every message indefinitely will eventually cause the DynamoDB item to exceed the 400KB
item size limit and will also send increasingly large payloads to Anthropic (increasing cost and
latency).
Mitigation: In `ChatSessionService.handleMessage`, add a slice after loading history to keep
only the last N messages (e.g., 50) before calling Anthropic. This cap should be a named
constant, not a magic number.

**Medium — Missing `@nestjs/config` peer**
The current `package.json` has no `@nestjs/config`. `ConfigModule` and `ConfigService` will not
resolve. The install step (step 1) must complete before any other step.
Mitigation: Sequenced as step 1 in the implementation order.

**Low — Discord client not destroyed on app shutdown**
NestJS lifecycle hooks include `OnModuleDestroy`. Without implementing it, the Discord
WebSocket connection will hang on graceful shutdown, preventing the process from exiting cleanly.
Mitigation: Implement `OnModuleDestroy` in `DiscordService` and call `this.client.destroy()`.
This can be added at the same time as the `onModuleInit` implementation.

**Low — `APP_ENV` env var naming vs. `NODE_ENV`**
The Zod schema includes both `APP_ENV` and (implicitly via the configuration factory) an
assumption about `NODE_ENV`. The endpoint defaulting logic in `configuration.ts` should key
off `APP_ENV === "local"`, not `NODE_ENV === "development"`, to stay consistent with the
schema's defined enum values.
Mitigation: Confirm in the configuration factory that all branching uses `APP_ENV`, not `NODE_ENV`.

---

## Testing Strategy

### Unit tests

**`src/services/chat-session.service.spec.ts`**
- Mock `DynamoDBDocumentClient` (inject a jest mock for `DYNAMO_DB_CLIENT`)
- Mock `AnthropicService` (`sendMessage` returns a fixed string)
- Mock `DatabaseConfigService` (`conversationsTable` returns `"test-table"`)
- Test: new session (no existing item) creates history with user + assistant messages and calls `PutCommand`
- Test: existing session appends to existing messages array
- Test: returned value equals the mocked `AnthropicService` reply

**`src/services/anthropic.service.spec.ts`**
- Mock `AnthropicConfigService`
- Mock the Anthropic SDK client (spy on `messages.create`)
- Test: passes the messages array through correctly
- Test: extracts `.text` from the first content block and returns it
- Test: throws a descriptive error when `content[0].type` is not `"text"`

**`src/config/env.validation.spec.ts`**
- Test: valid env object passes without throwing
- Test: object missing `DYNAMODB_REGION` throws with a message containing "Config validation failed"
- Test: `APP_ENV` defaults to `"local"` when not provided

### Integration / E2E tests

Not required for initial foundation. Integration tests should be added once a real DynamoDB
Local Docker container is available in the test environment. Use `@aws-sdk/client-dynamodb` with
`endpoint: "http://localhost:8000"` and a real table created via `CreateTableCommand` in a
`beforeAll` hook.

### Manual verification steps

1. Start DynamoDB Local: `docker run -p 8000:8000 amazon/dynamodb-local`
2. Create the conversations table:
   ```
   aws dynamodb create-table \
     --table-name chat-conversations \
     --attribute-definitions AttributeName=sessionId,AttributeType=S \
     --key-schema AttributeName=sessionId,KeyType=HASH \
     --billing-mode PAY_PER_REQUEST \
     --endpoint-url http://localhost:8000
   ```
3. Set env vars in `.env.local` (without `DISCORD_BOT_TOKEN` for initial smoke test)
4. Run `npm run start:dev` — confirm no DI resolution errors in the startup log
5. Add `ANTHROPIC_API_KEY` and call `ChatSessionService.handleMessage` directly via a temporary
   test controller or unit test to verify the Anthropic + DynamoDB round trip before wiring Discord

### Regression areas

- `AppController` and `AppService` scaffold: the existing `GET /` route must continue to
  respond after `AppModule` is modified. Verify with `curl http://localhost:3000`.

---

## Implementation Recommendations

**Follow the ecommerce backend's config service pattern exactly.** The `getOrThrow` vs `get`
distinction is intentional: required fields use `getOrThrow` (throws at runtime with a clear
message if missing), optional fields use `get` (returns `undefined`). Do not use `get` for
required fields — it silently returns `undefined` and causes confusing downstream null errors.

**Do not inject the Anthropic SDK client as a NestJS provider.** The SDK client is not a class
NestJS knows about and does not benefit from the DI lifecycle. Instantiate it inside
`AnthropicService`'s constructor and store it as a private field. This is the same pattern
the ecommerce backend uses for the Stripe SDK.

**Keep `DiscordService` thin.** It should only parse the incoming Discord event and hand off to
`ChatSessionService`. No DynamoDB or Anthropic logic should live here. This keeps the service
testable independently of Discord.

**Name the conversation history constant.** In `ChatSessionService`, the history cap (e.g., last
50 messages) should be a named constant at the top of the file, not a magic number inline in the
slice call.

**Use `OnModuleInit` not a constructor call for Discord login.** Calling `client.login()` in the
constructor is a common mistake — the NestJS container may not have finished resolving all
dependencies at that point. `OnModuleInit.onModuleInit()` is the correct hook and is guaranteed
to run after the module is fully initialized.

**The `DYNAMO_DB_CLIENT` token string must be the same value in both the provider and the
injection site.** Export it as a named constant from `src/providers/dynamodb.provider.ts` and
import it into `ChatSessionService` rather than duplicating the string literal.
