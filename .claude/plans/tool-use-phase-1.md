# Tool Use Phase 1 — Implementation Plan

## Objective

Add Anthropic tool-use (function calling) support to the chat session module. Introduce a tool registry,
a first concrete tool (`save_user_fact`), and a tool loop inside `ChatSessionService` that handles the
Anthropic `tool_use` → execute → `tool_result` → continue pattern. This enables Claude to call tools
mid-conversation and have their results inform the final reply.

---

## SDK Version Verification

Installed: `@anthropic-ai/sdk ^0.85.0`

The Anthropic TypeScript SDK at this version fully supports tool use. The relevant types are exported
directly from the SDK — `Tool`, `ToolUseBlock`, `ToolResultBlockParam`, `MessageParam`, and
`ContentBlockParam`. These should be used as the underlying type foundations in our own domain types
rather than re-inventing shapes.

Key protocol facts confirmed from official docs:

- `stop_reason: "tool_use"` signals Claude wants to call a tool; `stop_reason: "end_turn"` signals done
- `tool_use` blocks live in the **assistant** role response content array
- `tool_result` blocks must live in a **user** role message immediately following the assistant's tool_use message
- `tool_result` blocks must appear **first** in the user message content array (before any text blocks)
- Multiple `tool_use` blocks can appear in a single assistant turn — all must be executed and all results must be returned in one user message
- `tool_result` structure: `{ type: "tool_result", tool_use_id: string, content: string, is_error?: boolean }`
- `tool_use` structure: `{ type: "tool_use", id: string, name: string, input: object }`
- Tool definition structure: `{ name, description, input_schema: { type: "object", properties, required } }`

---

## Affected Files and Modules

### Create

| File | Purpose |
|---|---|
| `src/types/Tool.ts` | Domain types for tools: interface, definition shape, execution context, result |
| `src/types/ChatContent.ts` | Content block union types for multi-modal message content |
| `src/tools/tool-registry.service.ts` | Injectable registry that collects all tools and dispatches execution |
| `src/tools/save-user-fact.tool.ts` | First concrete tool — writes USER_FACT items to DynamoDB |
| `src/validation/tool.schema.ts` | Zod schema for save_user_fact input validation |
| `src/tools/tool-registry.service.spec.ts` | Unit tests for ToolRegistry |
| `src/tools/save-user-fact.tool.spec.ts` | Unit tests for SaveUserFactTool |

### Modify

| File | Change |
|---|---|
| `src/types/ChatSession.ts` | Update `ChatSessionMessage.content` to accept serialized content blocks; add `ChatSessionMessageContent` helper type |
| `src/services/anthropic.service.ts` | New signature accepting tools + system prompt; return full response object not just string |
| `src/services/chat-session.service.ts` | Rewrite `handleMessage` to implement tool loop; inject ToolRegistry |
| `src/services/chat-session.service.spec.ts` | Update tests for new `sendMessage` signature and tool loop behavior |
| `src/app.module.ts` | Register SaveUserFactTool, ToolRegistry, wire multi-provider |

### Review Only

| File | Reason |
|---|---|
| `src/providers/dynamodb.provider.ts` | SaveUserFactTool needs to inject `DYNAMO_DB_CLIENT` — confirm token name |
| `src/services/database-config.service.ts` | SaveUserFactTool needs `conversationsTable` |
| `src/services/identity.service.spec.ts` | Understand test patterns before writing new specs |

---

## Dependencies and Architectural Considerations

### Tool DI Pattern — Multi-Provider with Custom Injection Token

The plan recommends **Option A: multi-provider with injection token**, not individual constructor injection. Here is the justification:

- Phase 2 will add more tools. With option (b), each new tool requires a constructor parameter change in ToolRegistry and a re-registration step in AppModule.
- With option (a), adding a new tool is a single change: register it in AppModule as `{ provide: CHAT_TOOLS_TOKEN, useClass: NewTool, multi: true }`. ToolRegistry's constructor never changes.
- NestJS's `multi: true` provider pattern is idiomatic for open-ended collections (interceptors, event handlers, validators).

Implementation:

```
// In src/tools/tool-registry.service.ts
export const CHAT_TOOLS_TOKEN = "CHAT_TOOLS";

// In app.module.ts providers:
{ provide: CHAT_TOOLS_TOKEN, useClass: SaveUserFactTool, multi: true },
ToolRegistryService,
```

ToolRegistry constructor receives `@Inject(CHAT_TOOLS_TOKEN) private readonly tools: ChatTool[]`.

### Content Block Storage Contract

The current `ChatSessionMessageRecord.content` is a plain `string`. After this change, content will be
stored as a JSON-serialized `ChatContentBlock[]`. This is a **breaking schema change for existing DynamoDB
items** — they have string content, not JSON arrays. The history loader must handle both forms gracefully.

Strategy: wrap `JSON.parse` in a try/catch. On failure (legacy plain-string item), construct a synthetic
`[{ type: "text", text: rawContent }]` block array and continue. Log a debug-level notice — this is
expected during the transition period, not an error.

### Anthropic SDK Type Alignment

`AnthropicService.sendMessage` will now return a typed response object. The SDK's
`Anthropic.Messages.Message` type is the correct return type from `client.messages.create()`. Rather than
duplicating the full shape, define a slim domain type `ChatAnthropicResponse` in `src/types/` that captures
what `ChatSessionService` actually needs: `content: ChatContentBlock[]` and `stop_reason: string`. The
service layer should not couple directly to the SDK's exported types — it should use the domain wrapper.

### Message Array Type for Anthropic Calls

`ChatSessionService` builds the messages array in-memory during the tool loop. The in-memory representation
uses `ChatSessionMessage` with a `content` field that is either a string (legacy) or a `ChatContentBlock[]`.
The Anthropic SDK's `messages.create()` requires `MessageParam[]` where content can be a string or a
`ContentBlockParam[]`. The mapping is clean — no structural impedance.

However, the `ChatSessionMessage` type currently defines `content: string`. This must be widened to
`content: string | ChatContentBlock[]` to support tool_use and tool_result blocks in the in-memory array.
DynamoDB storage will always serialize to string via `JSON.stringify`.

---

## Step-by-Step Implementation Sequence

### Step 1 — Define content block types in `src/types/ChatContent.ts`

**What:** Create a new types file containing:
- `ChatTextContentBlock` — `{ type: "text"; text: string }`
- `ChatToolUseContentBlock` — `{ type: "tool_use"; id: string; name: string; input: Record<string, unknown> }`
- `ChatToolResultContentBlock` — `{ type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }`
- `ChatContentBlock` — union of the three above

**Why first:** All other types, services, and tools depend on these shapes. No dependencies.

**Done when:** File compiles with `npx tsc --noEmit` with no errors. Types exported correctly.

---

### Step 2 — Update `src/types/ChatSession.ts`

**What:**
- Change `ChatSessionMessage.content` from `string` to `string | ChatContentBlock[]`
- Add `ChatSessionMessageContent` as a type alias for `ChatContentBlock[]` (used as the parsed form of stored content)
- Add a JSDoc comment on `ChatSessionMessageRecord.content` noting it is stored as JSON-serialized `ChatContentBlock[]` for messages involving tools, or a plain string for legacy records

**Why here:** `ChatSessionService` and `AnthropicService` changes in later steps depend on the updated type. Do this before touching services.

**Done when:** TypeScript compiles with no errors. `ChatSessionMessageRecord.content` remains `string` (it is the DynamoDB record shape — always a string on disk).

---

### Step 3 — Define tool domain types in `src/types/Tool.ts`

**What:** Create:
- `ChatToolDefinition` — `{ name: string; description: string; input_schema: Record<string, unknown> }` — the shape sent to Anthropic
- `ChatToolExecutionContext` — `{ sessionUlid: string }` — what gets passed into a tool's `execute` method
- `ChatToolExecutionResult` — `{ result: string; isError?: boolean; metadata?: Record<string, unknown> }`
- `ChatTool` — interface: `{ name: string; description: string; inputSchema: Record<string, unknown>; execute(input: unknown, context: ChatToolExecutionContext): Promise<ChatToolExecutionResult> }`

**Naming rationale:** Per the style-enforcer rule, all types in a domain file must be prefixed with the domain name. This file is `Tool.ts` so prefix is `ChatTool*` to avoid confusion with `Tool` from the Anthropic SDK which may be imported in other files.

**Why here:** ToolRegistry and SaveUserFactTool depend on these. Must come before those files.

**Done when:** Compiles cleanly. No inline types in any service file.

---

### Step 4 — Create Zod validation schema in `src/validation/tool.schema.ts`

**What:** Define `saveUserFactInputSchema` using Zod:
```
z.object({
  key: z.string().min(1),
  value: z.string().min(1),
})
```
Export the schema and export `SaveUserFactInput` as `z.infer<typeof saveUserFactInputSchema>`.

**Why here:** `SaveUserFactTool.execute` will import this schema. Validation logic lives in `src/validation/` per project conventions, not in the tool itself.

**Done when:** Schema compiles and `z.safeParse` call with a valid object returns `success: true`.

---

### Step 5 — Implement `src/tools/save-user-fact.tool.ts`

**What:** `@Injectable()` class implementing `ChatTool`:
- `name = "save_user_fact"`
- `description` — 3–4 sentences per the Anthropic best-practices guidance in the docs. Exact text:
  `"Save a fact about the user for long-term memory. Use this when the user shares personal information, preferences, or context worth remembering across conversations. Provide a short snake_case key such as 'employer' or 'favorite_color' and a concise value. Do not use this for temporary conversational context — only for stable facts the user would expect to be remembered."`
- `inputSchema` — the JSON schema object directly: `{ type: "object", properties: { key: { type: "string", description: "Snake_case identifier for the fact, e.g. 'employer'" }, value: { type: "string", description: "Concise value for the fact" } }, required: ["key", "value"] }`
- Constructor: `@Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient` and `private readonly databaseConfig: DatabaseConfigService`
- `execute(input: unknown, context: ChatToolExecutionContext): Promise<ChatToolExecutionResult>`:
  1. Run `saveUserFactInputSchema.safeParse(input)` — on failure return `{ result: "Invalid input: <zod error summary>", isError: true }`
  2. DynamoDB `PutCommand` with:
     - `PK: CHAT_SESSION#<context.sessionUlid>`
     - `SK: USER_FACT#<parsed.key>`
     - `value: parsed.value`
     - `updatedAt: new Date().toISOString()`
  3. On success: `{ result: "Fact saved successfully." }`
  4. On DynamoDB error: `{ result: "Failed to save fact: <error.message>", isError: true }` — catch and return, never throw
  5. Logger: `this.logger.debug("Executing tool [name=save_user_fact sessionUlid=<ctx.sessionUlid>]")` — NEVER log key or value

**SK key design note:** `USER_FACT#<key>` means re-saving the same key overwrites the previous value via `PutCommand`. This is the correct behavior — facts should be updatable.

**Why here:** Depends on types from steps 1–4. No other services depend on this.

**Done when:** Unit test passes for success path, Zod failure path, and DynamoDB error path.

---

### Step 6 — Implement `src/tools/tool-registry.service.ts`

**What:** `@Injectable()` service:
- Export `CHAT_TOOLS_TOKEN = "CHAT_TOOLS"` as a string constant
- Constructor: `constructor(@Inject(CHAT_TOOLS_TOKEN) private readonly tools: ChatTool[])`
- `getAll(): ChatTool[]` — returns `this.tools`
- `getDefinitions(): ChatToolDefinition[]` — maps each tool to `{ name: tool.name, description: tool.description, input_schema: tool.inputSchema }`
- `execute(toolName: string, input: unknown, context: ChatToolExecutionContext): Promise<ChatToolExecutionResult>`:
  1. Find tool by name: iterate `this.tools`, compare `.name`
  2. If not found: `this.logger.warn("Tool not found [name=<toolName>]")` — return `{ result: "Tool not found: <toolName>", isError: true }`
  3. If found: `this.logger.debug("Dispatching tool [name=<toolName> sessionUlid=<context.sessionUlid>]")`
  4. Call `tool.execute(input, context)` in a try/catch
  5. On thrown error: `this.logger.error("Tool threw an error [name=<toolName>]", error)` — return `{ result: "Tool execution failed unexpectedly.", isError: true }`
  6. Return the result

**Why here:** Depends on types from step 3 and the tool from step 5. `ChatSessionService` (step 8) depends on this.

**Done when:** Unit tests for dispatch, not-found path, and thrown error path pass.

---

### Step 7 — Update `src/services/anthropic.service.ts`

**What:**
- Add `ChatAnthropicResponse` type to `src/types/ChatSession.ts` (or a new `src/types/Anthropic.ts` if preferred — given it's only used by AnthropicService and ChatSessionService, adding it to `ChatSession.ts` is acceptable to keep the types co-located with message types): `{ content: ChatContentBlock[]; stop_reason: string }`
- New method signature: `sendMessage(messages: ChatSessionMessage[], tools: ChatToolDefinition[], systemPrompt?: string): Promise<ChatAnthropicResponse>`
- Pass `tools` to `client.messages.create()` when the array is non-empty. When empty, omit the parameter entirely (no tools = clean request).
- Pass `system: systemPrompt` when provided.
- Remove the current text-only extraction and throw — return the full `{ content, stop_reason }` mapped to `ChatAnthropicResponse`
- Content mapping: the SDK returns `ContentBlock[]` where blocks are `TextBlock | ToolUseBlock`. Map these to `ChatContentBlock[]` by matching the `type` field — `text` → `ChatTextContentBlock`, `tool_use` → `ChatToolUseContentBlock`. Any unknown types: log warn and skip.
- Logging: `debug` log should now include `toolCount=${tools.length}` not tool contents

**Backward compatibility note:** This is an internal service. The only callers are `ChatSessionService`. Both will be updated together. No external API contract is broken.

**Why here:** Must be done before `ChatSessionService` update (step 8) which calls this service.

**Done when:** TypeScript compiles. Existing unit tests updated to match new return shape.

---

### Step 8 — Rewrite `src/services/chat-session.service.ts`

This is the core change. The rewrite follows this exact logic:

**Constants to add at top of file:**
```
const MAX_TOOL_LOOP_ITERATIONS = 10;
const SYSTEM_PROMPT = "You are a helpful AI assistant with access to tools for saving information about the user. Use tools when appropriate, and respond naturally otherwise.";
const USER_FACT_SK_PREFIX = "USER_FACT#";  // Not needed here — lives in save-user-fact.tool.ts
```

**Constructor:** Add `private readonly toolRegistry: ToolRegistryService`

**`handleMessage` rewrite:**

1. Load history from DynamoDB (unchanged query)
2. Parse each history item's `content` field into `ChatContentBlock[]`:
   - Try `JSON.parse(item.content)` — on success use the parsed blocks
   - On `JSON.parse` failure (legacy string): construct `[{ type: "text", text: item.content }]`
   - Log a debug notice if parse fails (not an error — expected during transition)
3. Build initial `messages: ChatSessionMessage[]` from parsed history
4. Append new user message: `{ role: "user", content: [{ type: "text", text: userMessage }] }`
5. Fetch tool definitions: `const toolDefinitions = this.toolRegistry.getDefinitions()`
6. Enter tool loop (`let iteration = 0`; `while (iteration < MAX_TOOL_LOOP_ITERATIONS)`):
   a. `iteration++`
   b. Log: `"Calling Anthropic [sessionUlid=<x> iteration=<n> historySize=<n>]"`
   c. Call `await this.anthropicService.sendMessage(messages, toolDefinitions, SYSTEM_PROMPT)`
   d. Append assistant message to `messages`: `{ role: "assistant", content: response.content }`
   e. If `response.stop_reason === "end_turn"`: log `"Tool loop complete [sessionUlid=<x> iterations=<n>]"` and break
   f. If `response.stop_reason === "tool_use"`:
      - Extract all `tool_use` blocks from `response.content` (filter by `type === "tool_use"`)
      - Log: `"Tool use detected [sessionUlid=<x> count=<n>]"`
      - For each tool_use block: call `await this.toolRegistry.execute(block.name, block.input, { sessionUlid })`
      - Build tool_result blocks: one per tool_use, matching `tool_use_id` to `block.id`
      - Build and append a user message: `{ role: "user", content: toolResultBlocks }` (tool_results first, per protocol)
      - Continue loop
   g. On any other stop_reason: log warn and break
7. After loop: if `iteration >= MAX_TOOL_LOOP_ITERATIONS` log warn `"Tool loop max iterations reached [sessionUlid=<x>]"`
8. Persist messages to DynamoDB:
   - Persist the new user message (single PutCommand — content serialized as `JSON.stringify(blocks)`)
   - Persist each assistant message added during the loop (one PutCommand per message)
   - Persist each tool_result user message added during the loop (one PutCommand per message)
   - All messages use `MESSAGE_SK_PREFIX + ulid()` for SK to maintain ordering
   - All content stored as `JSON.stringify(contentBlocks)`
9. Update metadata `lastMessageAt` (unchanged)
10. Extract final text reply: find the last assistant message in `messages`, filter its content for `type === "text"` blocks, concatenate their `text` fields
11. Return concatenated text (empty string if no text blocks found — log warn)

**Why here:** Last service to modify. Depends on everything above.

**Done when:** Tool loop integration test passes (see Testing Strategy). Existing unit tests updated or replaced.

---

### Step 9 — Update `src/app.module.ts`

**What:**
- Import `ToolRegistryService` and `CHAT_TOOLS_TOKEN` from `src/tools/tool-registry.service.ts`
- Import `SaveUserFactTool` from `src/tools/save-user-fact.tool.ts`
- Add to `providers` array:
  ```
  { provide: CHAT_TOOLS_TOKEN, useClass: SaveUserFactTool, multi: true },
  ToolRegistryService,
  ```
- `SaveUserFactTool` is NOT registered as a standalone provider — only via `CHAT_TOOLS_TOKEN`

**Why last:** Module wiring should happen after all providers are fully implemented and tested.

**Done when:** Application boots (`npm run start:dev`) without DI errors. All providers resolve.

---

### Step 10 — Update `src/services/chat-session.service.spec.ts`

**What:**
- Update `mockAnthropicService.sendMessage` mock to return `ChatAnthropicResponse` shape instead of string
- Add `mockToolRegistry` mock with `getDefinitions` and `execute` methods
- Update existing tests to match new message content format (blocks instead of strings)
- Add new test cases:
  - Single tool_use turn: mock returns `stop_reason: "tool_use"` with one tool_use block, then `stop_reason: "end_turn"` — verify two Anthropic calls made and one tool execution
  - Multiple tool_use blocks in single turn — verify all results sent in one user message
  - Max iterations guard — mock always returns `stop_reason: "tool_use"` — verify loop exits at 10

**Done when:** `npm test` passes with no failures.

---

## Risks and Edge Cases

### High

**Legacy DynamoDB content — JSON.parse failure**
Existing message items have plain string content. The history loader must not throw on these.
Mitigation: wrap JSON.parse in try/catch; on failure wrap as `[{ type: "text", text: rawContent }]`.
The `satisfies` constraint on `ChatSessionMessageRecord` ensures new writes are always strings — the parse failure path is only hit on legacy reads.

**tool_result order in user message**
Per the API spec, `tool_result` blocks must come FIRST in the user message content array. If text is mixed in before them, Anthropic returns a 400. Implementation must build the user message with tool_result blocks only (no text prefix) during the tool loop.

**tool_use_id mismatch**
Each `tool_result` block must have a `tool_use_id` matching the `id` field from the corresponding `tool_use` block. The implementation iterates the `tool_use` blocks in order and maps each to its result. No caching or lookup table needed — just iterate in order and pair.

**Infinite tool loop**
Claude could theoretically keep requesting tools indefinitely.
Mitigation: `MAX_TOOL_LOOP_ITERATIONS = 10` constant. On reaching the limit, log warn and break. The partial conversation (without a final `end_turn` text response) is returned — surface whatever text Claude produced before the limit was hit.

### Medium

**Tool execution throws unexpectedly**
`SaveUserFactTool.execute` catches DynamoDB errors and returns an error result. `ToolRegistry.execute` also has a catch-all wrapper. Neither path should throw to the caller. This must be verified in unit tests.

**Empty tool_use block input**
Claude may pass an empty or minimal `input` object if the user's message doesn't provide enough context. The Zod schema in `save-user-fact.tool.ts` validates with `.min(1)` on both key and value, returning an error result that Claude can relay to the user.

**Anthropic returns unexpected stop_reason**
New stop_reasons may be introduced (e.g., `"pause_turn"` for extended thinking). The loop handles `"end_turn"` and `"tool_use"` explicitly and logs warn + breaks on anything else. This is conservative — it avoids silent infinite loops on unexpected values.

**Content block type not in union**
If Anthropic adds new block types (e.g., `"thinking"` blocks), the content mapper in `AnthropicService` will encounter unknown types. The mapping should skip unknown types with a debug log rather than throwing.

### Low

**USER_FACT SK collisions**
`USER_FACT#employer` for a given session will be overwritten on a subsequent save with the same key. This is intentional — facts should be updatable. If the product later needs history of fact changes, a `createdAt`-based SK would be needed. For Phase 1, overwrite is correct.

**Empty final text response**
If Claude's last assistant message has only tool_use blocks and no text (unlikely with `auto` tool_choice), `handleMessage` returns an empty string. The Discord service would then send an empty message. Mitigation: add a warn log and return a fallback `"(no response)"` string — or verify the Discord service handles empty strings gracefully before choosing an approach.

---

## Testing Strategy

### Unit Tests

**`src/tools/save-user-fact.tool.spec.ts`** — colocated with the tool file:
- Zod validation failure (missing key) → returns `{ isError: true }` result
- Zod validation failure (empty string value) → returns `{ isError: true }` result
- Successful DynamoDB write → returns `{ result: "Fact saved successfully." }`
- DynamoDB throws → returns `{ isError: true }` result, does NOT throw
- Verify PutCommand item shape: correct PK, SK, value, updatedAt fields
- Use `aws-sdk-client-mock` (already installed)

**`src/tools/tool-registry.service.spec.ts`** — colocated:
- `getDefinitions()` maps tools to correct `{ name, description, input_schema }` shape
- `execute()` dispatches to correct tool by name
- `execute()` with unknown name returns error result (does not throw)
- `execute()` when tool's `execute` method throws returns error result (does not throw)

**`src/services/chat-session.service.spec.ts`** — update existing:
- All existing tests must continue to pass with updated mock shapes
- New: single tool_use loop iteration — verify two `sendMessage` calls
- New: multiple tool_use blocks — verify all tool_result blocks in one user message
- New: `stop_reason: "end_turn"` on first call — verify exactly one `sendMessage` call
- New: max iterations guard fires after 10 iterations

### Manual End-to-End Verification

1. Start the local dev server: `npm run start:local`
2. Send a Discord message (in the configured guild): "Remember that I work at Acme Corp"
3. Expected log trace (in order):
   - `Calling Anthropic [sessionUlid=<x> iteration=1 historySize=1]`
   - `Tool use detected [sessionUlid=<x> count=1]`
   - `Dispatching tool [name=save_user_fact sessionUlid=<x>]`
   - `Executing tool [name=save_user_fact sessionUlid=<x>]`
   - `Calling Anthropic [sessionUlid=<x> iteration=2 historySize=...]`
   - `Tool loop complete [sessionUlid=<x> iterations=2]`
4. Verify DynamoDB item (using local DynamoDB admin or AWS CLI):
   - `PK: CHAT_SESSION#<sessionUlid>`
   - `SK: USER_FACT#employer`
   - `value: "Acme Corp"`
   - `updatedAt` is present and recent
5. Follow up with: "What do you remember about me?" — Claude should respond with the saved fact

### Regression

- Run `npm test` — all existing tests must pass
- Send a plain conversational message with no expected tool use — verify the loop exits on first `end_turn` with exactly one Anthropic call
- Verify existing sessions with legacy string content load without errors (test by seeding a DynamoDB item with plain string content and sending a message on that session)

---

## Implementation Recommendations

**Type naming decision for `src/types/Anthropic.ts` vs `src/types/ChatSession.ts`**
`ChatAnthropicResponse` is a bridging type between AnthropicService and ChatSessionService. Placing it in `src/types/ChatSession.ts` keeps the types co-located with their consumers. If the AnthropicService grows more response types in future phases, move to a dedicated `src/types/Anthropic.ts`. For Phase 1, ChatSession.ts is the right home.

**Do not use the SDK's `Tool` type directly in service/types code**
The SDK exports `Tool` from `@anthropic-ai/sdk`. Do not use this type in `src/types/Tool.ts` or `ToolRegistry`. Define domain types and map at the boundary (inside `AnthropicService.sendMessage`). This decouples the domain model from the SDK version.

**Message persistence order matters**
When persisting messages at the end of the tool loop, they must be persisted in chronological order. Since ULID is time-sortable, generating a new ULID for each `PutCommand` in loop iteration order will naturally produce the correct query ordering.

**`satisfies` on DynamoDB PutCommand items**
Following the existing pattern in `ChatSessionService` and `IdentityService`, use `satisfies ChatSessionMessageRecord` on each `PutCommand` item to get compile-time completeness checks. This ensures that if `ChatSessionMessageRecord` gains a new required field, the service fails to compile rather than silently omitting the field.

**Zod v4 API**
The project uses `zod ^4.3.6`. In Zod v4, `schema.safeParse(input)` returns `{ success, data, error }` — the `error.issues` array contains issue objects. For error summarization, use `error.issues.map(issue => issue.message).join(", ")` to build a readable error string.

**No `as` assertions in content block mapping**
The style-enforcer prohibits `as` type assertions. When mapping SDK `ContentBlock` types to domain `ChatContentBlock` types in `AnthropicService`, use a discriminant check on the `type` field with explicit if-branches. TypeScript narrows the type from the `type` field without needing any assertion.
