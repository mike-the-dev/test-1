# Plan: Channel-Agnostic Chat Session Refactor

## Objective

Refactor the chat-session module so it operates purely on internal session ULIDs with no knowledge of Discord, web, or any specific frontend. Discord becomes a thin adapter that maps `message.author.id` to an internal session ULID via a new `IdentityService`. The existing single-item-per-session DynamoDB schema is replaced with a per-message item schema using a composite PK+SK key design, which requires the DynamoDB table to be recreated (or confirmed to use PK+SK composite keys). All type definitions land in `src/types/` following the domain-prefix naming convention enforced by the style guide.

---

## Affected Files and Modules

### Create
- `src/services/identity.service.ts` — new service: looks up or creates a session ULID from a `(source, externalId)` pair
- `src/services/identity.service.spec.ts` — unit tests for `IdentityService`
- `src/services/chat-session.service.spec.ts` — unit tests for the refactored `ChatSessionService`

### Modify
- `src/types/ChatSession.ts` — add `IdentityRecord`, `ChatSessionMetadataRecord`, `ChatSessionMessageRecord`; remove `ChatSessionRecord` (single-item shape no longer used); keep `ChatSessionMessage` and `ChatSessionRole`
- `src/services/chat-session.service.ts` — replace `GetCommand` (single-item) with `QueryCommand` (per-message items); accept `sessionUlid`; write individual message items; update metadata record; zero Discord references
- `src/services/discord.service.ts` — inject `IdentityService`; call `lookupOrCreateSession("discord", message.author.id)` before forwarding to `ChatSessionService`; remove `sessionId = message.channelId`
- `src/app.module.ts` — add `IdentityService` to `providers`
- `package.json` — add `ulid` dependency

### Review Only
- `src/providers/dynamodb.provider.ts` — no changes needed; `DynamoDBDocumentClient` is already wired correctly
- `src/services/database-config.service.ts` — no changes needed; `conversationsTable` getter already exists
- `src/config/configuration.ts` — no changes needed
- `src/config/env.schema.ts` — no changes needed
- `src/services/anthropic.service.ts` — no changes needed; `sendMessage(messages: ChatSessionMessage[])` signature remains compatible

---

## Dependencies and Architectural Considerations

### New npm Dependency
- `ulid` — pure TypeScript ULID generator. Install with `npm install ulid`. No `@types/ulid` needed; the package ships its own types.

### DynamoDB Table Schema (CRITICAL)
The current table is keyed on `{ sessionId: string }` (a single partition key with no sort key). The new schema requires **both a partition key `PK` (String) and a sort key `SK` (String)**. These are two different table definitions — DynamoDB does not allow adding a sort key to an existing table.

**Action required before implementation:** Verify whether the existing table in NoSQL Workbench has a composite PK+SK key. If it was created with `sessionId` as the only key (no SK), the table must be deleted and recreated with:
- Partition key: `PK` (String)
- Sort key: `SK` (String)

All item shapes in this plan assume PK+SK composite keys.

### Internal Module Dependencies
```
IdentityService
  └── DynamoDBDocumentClient (via DYNAMO_DB_CLIENT token)
  └── DatabaseConfigService

ChatSessionService
  └── DynamoDBDocumentClient
  └── DatabaseConfigService
  └── AnthropicService

DiscordService
  └── DiscordConfigService
  └── IdentityService   ← new injection
  └── ChatSessionService
```

### New DynamoDB Item Shapes

**Identity record** (one per external identity):
```
PK: IDENTITY#<source>#<externalId>   e.g. IDENTITY#discord#123456789
SK: IDENTITY#<source>#<externalId>
sessionUlid: string
createdAt: string (ISO 8601)
```

**Chat session message record** (one per message):
```
PK: CHAT_SESSION#<sessionUlid>
SK: MESSAGE#<messageUlid>
role: "user" | "assistant"
content: string
createdAt: string (ISO 8601)
```

**Chat session metadata record** (one per session):
```
PK: CHAT_SESSION#<sessionUlid>
SK: METADATA
createdAt: string (ISO 8601)
lastMessageAt: string (ISO 8601)
source: string
```

All three shapes share one DynamoDB table (`DYNAMODB_TABLE_CONVERSATIONS`). They are distinguished by PK prefix (`IDENTITY#` vs `CHAT_SESSION#`) and SK value.

### No Backward Compatibility with Existing Data
The current schema stores `{ sessionId, messages: [...] }` — a single item per session with a `messages` array. After this refactor, that item format is incompatible with the new QueryCommand-based history load. Any existing data in the table will be invisible to the new code (it will simply return no history, not crash), but it will also never be cleaned up automatically. If the table is recreated for the PK+SK change (see above), this is a non-issue.

---

## Step-by-Step Implementation Sequence

### 1. Install `ulid` package
**File:** `package.json` / `package-lock.json`

Run `npm install ulid`. Confirm `ulid` appears in `dependencies` (not `devDependencies`) in `package.json`.

**Done when:** `import { ulid } from "ulid"` resolves without TypeScript errors (`npx tsc --noEmit` passes).

---

### 2. Verify or recreate the DynamoDB table
**File:** NoSQL Workbench / AWS console / local DynamoDB

Before any code changes go to production, confirm the DynamoDB table has:
- Partition key: `PK` (String)
- Sort key: `SK` (String)

If the table was created with only `sessionId` as the key, recreate it. Update `.env.local` (or equivalent) if the table name changes.

**Done when:** The table schema shows both `PK` (HASH) and `SK` (RANGE) keys in NoSQL Workbench.

---

### 3. Update `src/types/ChatSession.ts`
**File:** `src/types/ChatSession.ts`

Add the following exported interfaces. Keep `ChatSessionRole` and `ChatSessionMessage` — they are still used as the in-memory shape passed to `AnthropicService.sendMessage()`. Remove `ChatSessionRecord` (the old single-item shape).

Interfaces to add (all domain-prefixed per style guide):

- `IdentityRecord` — DynamoDB item shape for identity lookup
  ```
  PK: string
  SK: string
  sessionUlid: string
  createdAt: string
  ```

- `ChatSessionMessageRecord` — DynamoDB item shape for a single message
  ```
  PK: string
  SK: string
  role: ChatSessionRole
  content: string
  createdAt: string
  ```

- `ChatSessionMetadataRecord` — DynamoDB item shape for session metadata
  ```
  PK: string
  SK: string
  createdAt: string
  lastMessageAt: string
  source: string
  ```

**Done when:** `npx tsc --noEmit` passes; `ChatSessionRecord` is gone; all three new interfaces are exported.

---

### 4. Implement `src/services/identity.service.ts`
**File:** `src/services/identity.service.ts` (create new)

```
@Injectable()
export class IdentityService {
  constructor(
    @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
    private readonly databaseConfig: DatabaseConfigService,
  ) {}

  async lookupOrCreateSession(source: string, externalId: string): Promise<string>
}
```

Implementation logic for `lookupOrCreateSession`:
1. Build `pk = \`IDENTITY#${source}#${externalId}\``
2. Issue a `GetCommand` with `Key: { PK: pk, SK: pk }`
3. If `result.Item` exists, return `result.Item.sessionUlid`
4. Generate `sessionUlid = ulid()`
5. Build an `IdentityRecord` item and issue a `PutCommand` with `ConditionExpression: "attribute_not_exists(PK)"` to guard against the race condition
6. If `PutCommand` throws a `ConditionalCheckFailedException`, re-issue the `GetCommand` and return the `sessionUlid` written by the winning request
7. Return `sessionUlid`

The `ConditionalCheckFailedException` check must not use `instanceof` (banned pattern). Check `error.name === "ConditionalCheckFailedException"` instead.

Import `IdentityRecord` from `../types/ChatSession`.

**Done when:** `npx tsc --noEmit` passes; service is decorated with `@Injectable()`; no Discord references present.

---

### 5. Refactor `src/services/chat-session.service.ts`
**File:** `src/services/chat-session.service.ts`

Replace the `GetCommand` single-item fetch with a `QueryCommand`. Replace the single `PutCommand` with two `PutCommand` calls (one per message). Add a third `PutCommand` to upsert the metadata record.

Updated `handleMessage(sessionUlid: string, userMessage: string): Promise<string>` sequence:

1. **Load history** — `QueryCommand` on the table:
   - `KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)"`
   - `ExpressionAttributeValues: { ":pk": \`CHAT_SESSION#${sessionUlid}\`, ":skPrefix": "MESSAGE#" }`
   - `ScanIndexForward: false`
   - `Limit: 50`
   - Reverse the returned items array to restore chronological order
   - Map each item to `ChatSessionMessage` shape (`{ role, content }`)

2. **Append user message in memory** — push `{ role: "user", content: userMessage }` onto the history array

3. **Call Anthropic** — `await this.anthropicService.sendMessage(history)`

4. **Write user message item** — `PutCommand` with a `ChatSessionMessageRecord` item:
   - `PK: \`CHAT_SESSION#${sessionUlid}\``
   - `SK: \`MESSAGE#${ulid()}\``
   - `role: "user"`, `content: userMessage`, `createdAt: new Date().toISOString()`

5. **Write assistant message item** — `PutCommand` with a `ChatSessionMessageRecord` item using a new ULID for SK; `role: "assistant"`, `content: reply`

6. **Upsert metadata record** — `PutCommand` with a `ChatSessionMetadataRecord` item:
   - `PK: \`CHAT_SESSION#${sessionUlid}\``
   - `SK: "METADATA"`
   - `lastMessageAt: new Date().toISOString()`
   - For `createdAt`: use `UpdateCommand` with `SET createdAt = if_not_exists(createdAt, :now)` OR accept that recreating metadata on every turn is acceptable (simplest approach: use `PutCommand` always, accept that `createdAt` on the metadata record will drift — see risks). Recommended: use `UpdateCommand` with `SET lastMessageAt = :now, createdAt = if_not_exists(createdAt, :now), #source = if_not_exists(#source, :source)` to preserve original creation time.
   - The `source` field on metadata requires the caller to pass it in, but `ChatSessionService` must remain source-agnostic. Two options:
     - **Option A (recommended):** Drop `source` from the metadata record in `ChatSessionService`. The service has no knowledge of the source. `IdentityService` could write the metadata record at session creation time (step 4 extension), where it does know the source.
     - **Option B:** Accept a `source` parameter on `handleMessage` — but this violates the zero-frontend-knowledge rule.
   - **Adopt Option A:** `ChatSessionService` metadata record contains only `createdAt` and `lastMessageAt`. `IdentityService.lookupOrCreateSession` writes the initial metadata record (with `source`) at session creation time using `ConditionExpression: "attribute_not_exists(PK)"` so it only fires once.

7. **Return** `reply`

Remove all imports of `GetCommand`. Import `QueryCommand` from `@aws-sdk/lib-dynamodb`. Import `ChatSessionMessageRecord`, `ChatSessionMetadataRecord` from `../types/ChatSession`. Import `ulid` from `ulid`. Remove any reference to `sessionId`, Discord, channels, or external identifiers.

Use `satisfies` on DynamoDB item literals where the type system benefits from a completeness check (per style guide exception for service files).

**Done when:** `npx tsc --noEmit` passes; zero occurrences of "discord", "channel", "user" (as Discord concept), or "sessionId" remain; `GetCommand` is no longer imported.

---

### 6. Refactor `src/services/discord.service.ts`
**File:** `src/services/discord.service.ts`

Inject `IdentityService`. Remove the `sessionId = message.channelId` line.

Updated `messageCreate` handler:
1. Guard: `if (message.author.bot) return`
2. `const sessionUlid = await this.identityService.lookupOrCreateSession("discord", message.author.id)`
3. `const reply = await this.chatSessionService.handleMessage(sessionUlid, message.content)`
4. `await message.reply(reply)`

No direct DynamoDB access. No `DYNAMO_DB_CLIENT` injection. No table name references.

**Done when:** `npx tsc --noEmit` passes; `message.channelId` is gone; `IdentityService` is injected; no direct DynamoDB imports present.

---

### 7. Update `src/app.module.ts`
**File:** `src/app.module.ts`

Add `IdentityService` to the `providers` array. Add the corresponding import statement.

**Done when:** Application boots without `Nest can't resolve dependencies` errors; `npm run start:dev` starts cleanly.

---

### 8. Write unit tests
**Files:**
- `src/services/identity.service.spec.ts` (create)
- `src/services/chat-session.service.spec.ts` (create)

See Testing Strategy section below.

**Done when:** `npm test` passes with no failures.

---

## Risks and Edge Cases

### High

**1. Table key schema mismatch**
The current `GetCommand` uses `Key: { sessionId }`. If the real DynamoDB table (local or AWS) only has `sessionId` as its partition key (no sort key), all new `GetCommand`/`QueryCommand`/`PutCommand` calls using `{ PK, SK }` will fail at runtime with a `ValidationException`. The table must be verified before the first test run. This is the highest-risk item.

*Mitigation:* Verify table schema in NoSQL Workbench before any code is deployed or tested. If the key schema is wrong, drop and recreate the table. Document the required schema in a comment at the top of `database-config.service.ts` or in a `src/entities/` file.

**2. Concurrent identity creation race condition**
If two Discord messages arrive simultaneously from the same author, both could pass the `GetCommand` miss check and both attempt a `PutCommand` for the same identity record — resulting in two different session ULIDs and a lost session.

*Mitigation:* Use `ConditionExpression: "attribute_not_exists(PK)"` on the identity `PutCommand`. The losing writer catches `ConditionalCheckFailedException` (checked via `error.name`, not `instanceof`) and re-fetches the winning record. This is the standard optimistic-concurrency pattern for DynamoDB identity records.

**3. Partial write failure between user and assistant message**
Steps 4 and 5 of `handleMessage` are two separate `PutCommand` calls. If the process crashes between them (e.g., OOM, network timeout), the user message is persisted but the assistant message is not. On the next call, the user message will appear in history without a paired assistant response — which will confuse Anthropic's message alternation requirement.

*Mitigation (short term):* Accept this risk for now. The Anthropic API requires alternating user/assistant turns; if a lone user message appears at the end of history it will simply look like the user spoke twice. This is unlikely to cause an API error but may produce odd responses.

*Mitigation (long term):* Use DynamoDB `TransactWriteItems` to write both message records atomically. This is a future improvement — note it in a `TODO` comment in `chat-session.service.ts`.

### Medium

**4. ULID sort key ordering**
ULIDs are time-ordered, so `SK: MESSAGE#<ulid>` items will sort chronologically within `CHAT_SESSION#<sessionUlid>`. However, if two messages are written within the same millisecond (possible in tests), ULIDs share a timestamp prefix and rely on the random suffix for uniqueness. Two PutCommands for user+assistant within the same millisecond could sort non-deterministically in tests if the random suffix of the user ULID happens to be greater than the assistant's.

*Mitigation:* In practice this is harmless — messages are always fetched and re-reversed as a batch, not consumed individually in sort order. Document the ordering assumption.

**5. History load returns MESSAGE and METADATA items together**
The `QueryCommand` uses `begins_with(SK, "MESSAGE#")`. If this prefix filter is omitted or typo'd, the `METADATA` record will be included in the history items and will fail to map to `ChatSessionMessage` (it has no `role` or `content` field), likely surfacing as `undefined` values passed to Anthropic.

*Mitigation:* The `begins_with(SK, "MESSAGE#")` prefix in `KeyConditionExpression` is the correct guard. Validate in tests that a session with a metadata record still returns only message items.

**6. `satisfies` completeness check scope**
The style guide allows `satisfies` on DynamoDB object literals in `src/services/` as a compile-time completeness check. New fields added to `ChatSessionMessageRecord` or `ChatSessionMetadataRecord` will surface as compile errors if the item literals in `chat-session.service.ts` and `identity.service.ts` use `satisfies`. Ensure this pattern is applied to catch future schema drift.

### Low

**7. Metadata `createdAt` drift on `PutCommand`**
If `ChatSessionService` uses a plain `PutCommand` for metadata (rather than `UpdateCommand` with `if_not_exists`), every turn will overwrite `createdAt` with the current timestamp. This corrupts the session creation time.

*Mitigation:* Use `UpdateCommand` with `SET createdAt = if_not_exists(createdAt, :now), lastMessageAt = :now` — this is explicitly called out in step 5, Option A, and must be implemented as `UpdateCommand`, not `PutCommand`.

**8. `ulid` package not in `dependencies`**
If `ulid` is installed as a `devDependency`, it will not be available in the production build.

*Mitigation:* Always install with `npm install ulid` (not `--save-dev`).

---

## Testing Strategy

### Unit Tests

**`src/services/identity.service.spec.ts`**

Mock `DynamoDBDocumentClient` and `DatabaseConfigService`. Test:
- Cache hit: `GetCommand` returns an item — returns existing `sessionUlid`, no `PutCommand` fired
- Cache miss (no contention): `GetCommand` returns no item — generates a ULID, fires `PutCommand`, returns new `sessionUlid`
- Race condition: `GetCommand` miss → `PutCommand` throws `ConditionalCheckFailedException` → second `GetCommand` returns winning record → returns that `sessionUlid`
- PK format: assert `PK` is `IDENTITY#discord#123456789` for `("discord", "123456789")`

**`src/services/chat-session.service.spec.ts`**

Mock `DynamoDBDocumentClient`, `DatabaseConfigService`, and `AnthropicService`. Test:
- Empty history: `QueryCommand` returns no items — calls Anthropic with only the user message — writes two message items — writes/updates metadata
- Non-empty history: `QueryCommand` returns items in reverse order — verifies reversal — passes correct chronological history to Anthropic
- History limit: generate 51 message items from the mock — verify only 50 are passed to Anthropic (the `Limit: 50` query enforces this server-side, but test the slice logic if any is present)
- Metadata write: assert an `UpdateCommand` (not `PutCommand`) is issued for the metadata record
- Return value: assert the return value is the string from `AnthropicService.sendMessage`
- Zero Discord references: assert no import of `discord.js` or reference to `channelId` / `author`

**`src/services/discord.service.spec.ts`** (if it doesn't exist — check first)

- Assert `lookupOrCreateSession("discord", message.author.id)` is called, not `message.channelId`
- Assert `chatSessionService.handleMessage` receives the ULID returned by `identityService`, not `channelId`

### Manual Verification Steps
1. Start local DynamoDB (e.g., `docker run -p 8000:8000 amazon/dynamodb-local`)
2. Recreate the table with PK (String) + SK (String) using NoSQL Workbench or AWS CLI
3. `npm run start:dev`
4. Send a Discord message — confirm a reply is received
5. Send a second message in the same channel — confirm the assistant has context from the first exchange
6. In NoSQL Workbench, verify three item types exist: `IDENTITY#discord#...`, `CHAT_SESSION#...#MESSAGE#...`, `CHAT_SESSION#...#METADATA`
7. Send a message from a different Discord user ID — confirm a separate session ULID is created (different PK prefix in DynamoDB)

### Regression Areas
- `AnthropicService.sendMessage` signature is unchanged; no regression expected there
- `DiscordService` bot-message guard (`message.author.bot`) must remain in place
- `DatabaseConfigService.conversationsTable` is used by both `IdentityService` and `ChatSessionService` — both read from the same table name, which is correct for single-table design

---

## Implementation Recommendations

**Bottom-up sequence is mandatory.** Types must be defined before services that import them. `IdentityService` must exist before `DiscordService` injects it. `app.module.ts` is updated last once all services compile.

**The `UpdateCommand` for metadata is non-trivial.** The `UpdateCommand` from `@aws-sdk/lib-dynamodb` uses `UpdateExpression`, `ExpressionAttributeValues`, and optionally `ExpressionAttributeNames` (required if attribute names conflict with DynamoDB reserved words — `source` is not reserved, but double-check). The expression for metadata should be:
```
UpdateExpression: "SET createdAt = if_not_exists(createdAt, :now), lastMessageAt = :now"
ExpressionAttributeValues: { ":now": new Date().toISOString() }
```
This is a `PutItem`-equivalent upsert for `createdAt` while always refreshing `lastMessageAt`.

**Do not define types inline in service files.** All item shapes must be imported from `src/types/ChatSession.ts`. The style guide is explicit: no inline interfaces in services.

**`satisfies` on DynamoDB item literals.** Per the style-enforcer exception, use `satisfies ChatSessionMessageRecord` and `satisfies IdentityRecord` on the item object literals in the `PutCommand` calls. This ensures that if a required field is added to these types later, the service immediately fails to compile.

**Error in `IdentityService` must not use `instanceof`.** Use `error.name === "ConditionalCheckFailedException"` for the conditional check failure guard. The style guide bans `instanceof Object` checks; more broadly, `instanceof` on AWS SDK error classes is unreliable across module boundaries anyway.

**The `source` field on the metadata record belongs in `IdentityService`.** Since `ChatSessionService` must have zero knowledge of the source, the initial metadata write (with `source: "discord"` or any source) should happen inside `lookupOrCreateSession` at session creation time. This keeps `ChatSessionService` purely session-scoped.
