# Onboarding Budget + History Hydration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade web chat sessions to be server-authoritative for onboarding state (splash completion + budget) and hydratable for returning visitors. Drops the "auto-send budget as an opening user message" hack in favor of structured fields on the session METADATA record, with a prepended system note that carries budget context into every Anthropic call.

**Architecture:** Two new fields on the existing `ChatSessionMetadataRecord` (`onboarding_completed_at`, `budget_cents`). Two new endpoints: `POST /chat/web/sessions/:sessionUlid/onboarding` and `GET /chat/web/sessions/:sessionUlid/messages`. `POST /chat/web/sessions` response gains `onboardingCompletedAt` + `budgetCents` (null for new sessions, populated for returning). `ChatSessionService.handleMessage` reads `budget_cents` and passes it to `AnthropicService.sendMessage` as a second, **uncached** system block — preserves the 2,734-token cached prefix proven out by the 2026-04-19 A/B test, and adds only the user-specific budget note per session.

**Tech Stack:** NestJS, TypeScript (strict), Zod, `@anthropic-ai/sdk`, AWS SDK v3 DynamoDB Document Client, Jest + `aws-sdk-client-mock`.

**Locked API contract (from frontend sync):**
- `POST /chat/web/sessions` response: gains `onboardingCompletedAt: string | null` + `budgetCents: number | null`.
- `POST /chat/web/sessions/:sessionUlid/onboarding` — body `{ budgetCents: number }` (positive int), returns the full session shape.
- `GET /chat/web/sessions/:sessionUlid/messages` — returns `{ messages: { id, role, content, timestamp }[] }`, filtered to user + assistant text only (tool_use / tool_result blocks dropped from the wire).

**Out of scope (deferred):**
- Backend-generated welcome turn on onboarding (frontend uses a static empty state for v1).
- Referer + CSP `frame-ancestors` (still queued from prior plan).
- Onboarding expiry / reset.

---

## File Structure

**Modified files (no new files for the feature; new spec blocks added inline):**

- `src/types/ChatSession.ts` — extend `ChatSessionMetadataRecord` with `onboarding_completed_at?: string` + `budget_cents?: number`.
- `src/types/WebChat.ts` — extend `WebChatCreateSessionResponse`, add `WebChatOnboardingRequest`, `WebChatOnboardingResponse` (same shape as create-session response), `WebChatHistoryMessage`, `WebChatMessagesResponse`.
- `src/validation/web-chat.schema.ts` — add `onboardingSchema` (`budgetCents`: positive integer, max 100_000_000 cents = $1M sanity cap) and `sessionUlidParamSchema` for the route param.
- `src/services/anthropic.service.ts` — add optional `dynamicSystemContext?: string` argument to `sendMessage`; append an uncached second `text` block after the cached prefix when present. The existing cache_control marker stays on the first (static) block only.
- `src/services/identity.service.ts` — change `lookupOrCreateSession` to return `{ sessionUlid, onboardingCompletedAt: string | null, budgetCents: number | null }` instead of just `string`. Existing-session path fetches METADATA; new-session path returns `null`/`null`.
- `src/services/chat-session.service.ts` — after loading METADATA in `handleMessage`, if `budget_cents` is set, build a dynamic system context string and pass it into `AnthropicService.sendMessage`. Also add a new public method `getHistoryForClient(sessionUlid): Promise<WebChatHistoryMessage[]>` with the tool-block filter.
- `src/controllers/web-chat.controller.ts` — update `createSession` to return the new fields; add `@Post(":sessionUlid/onboarding")` and `@Get(":sessionUlid/messages")` handlers.
- Existing spec files updated inline for each change.

Each task below is TDD-structured: red test → green implementation → commit.

---

### Task 1: Extend types (`ChatSession.ts` + `WebChat.ts`)

**Files:**
- Modify: `src/types/ChatSession.ts`
- Modify: `src/types/WebChat.ts`

- [ ] **Step 1: Extend `ChatSessionMetadataRecord` with onboarding fields**

Edit `src/types/ChatSession.ts`. Replace the `ChatSessionMetadataRecord` interface with:

```ts
export interface ChatSessionMetadataRecord {
  PK: string;
  SK: string;
  _createdAt_: string;
  _lastUpdated_: string;
  source: string;
  agent_name?: string;
  account_id?: string;
  onboarding_completed_at?: string;
  budget_cents?: number;
}
```

- [ ] **Step 2: Extend `WebChat.ts` types**

Edit `src/types/WebChat.ts`. Replace the file contents with:

```ts
export interface WebChatCreateSessionRequest {
  agentName: string;
  guestUlid: string;
  accountUlid: string;
}

export interface WebChatSendMessageRequest {
  sessionUlid: string;
  message: string;
}

export interface WebChatCreateSessionResponse {
  sessionUlid: string;
  displayName: string;
  onboardingCompletedAt: string | null;
  budgetCents: number | null;
}

export interface WebChatSendMessageResponse {
  reply: string;
}

export interface WebChatOnboardingRequest {
  budgetCents: number;
}

export type WebChatOnboardingResponse = WebChatCreateSessionResponse;

export interface WebChatHistoryMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface WebChatMessagesResponse {
  messages: WebChatHistoryMessage[];
}
```

- [ ] **Step 3: Run `tsc` and commit**

Run: `npx tsc --noEmit`

Expected: errors at `web-chat.controller.ts` (the response now requires new fields). These resolve in Task 6. Commit now to keep the type changes atomic:

```bash
git add src/types/ChatSession.ts src/types/WebChat.ts
git commit -m "feat(web-chat): add onboarding + history types"
```

The tree is deliberately not clean at this commit; subsequent tasks resolve the controller mismatches.

---

### Task 2: Validation schemas (`web-chat.schema.ts`)

**Files:**
- Modify: `src/validation/web-chat.schema.ts`

- [ ] **Step 1: Add onboarding + session-ulid schemas**

Edit `src/validation/web-chat.schema.ts`. Replace the file contents with:

```ts
import { z } from "zod";

// 26-character Crockford base32: digits 0–9 and uppercase A–Z excluding I, L, O, U
const ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// Account ULID as sent by the widget: the DynamoDB PK form "A#<26-char-ulid>".
// The "A#" prefix is what the customer pastes into their embed snippet as
// data-account-ulid. The controller strips it before calling the account
// lookup; downstream code works with the raw ULID only.
const accountUlidRegex = /^A#[0-9A-HJKMNP-TV-Z]{26}$/;

// Generous upper bound: 100,000,000 cents = $1,000,000. Rejects obvious abuse
// without constraining legit medical-spa budgets (which top out in the tens
// of thousands of dollars).
const MAX_BUDGET_CENTS = 100_000_000;

export const createSessionSchema = z.object({
  agentName: z.string().min(1),
  guestUlid: z.string().regex(ulidRegex, "guestUlid must be a valid 26-character ULID"),
  accountUlid: z
    .string()
    .regex(accountUlidRegex, "accountUlid must be an A#-prefixed 26-character ULID"),
});

export const sendMessageSchema = z.object({
  sessionUlid: z.string().regex(ulidRegex, "sessionUlid must be a valid 26-character ULID"),
  message: z.string().min(1, "message must not be empty"),
});

export const onboardingSchema = z.object({
  budgetCents: z
    .number()
    .int("budgetCents must be an integer")
    .positive("budgetCents must be positive")
    .max(MAX_BUDGET_CENTS, "budgetCents exceeds the maximum allowed value"),
});

export const sessionUlidParamSchema = z
  .string()
  .regex(ulidRegex, "sessionUlid must be a valid 26-character ULID");

export type CreateSessionBody = z.infer<typeof createSessionSchema>;
export type SendMessageBody = z.infer<typeof sendMessageSchema>;
export type OnboardingBody = z.infer<typeof onboardingSchema>;
```

- [ ] **Step 2: Run `tsc` — should still error only at controller**

Run: `npx tsc --noEmit`

Expected: controller errors unchanged; schema types compile. Do not commit yet; bundle with Task 3.

---

### Task 3: `AnthropicService.sendMessage` — accept uncached dynamic system context

**Files:**
- Modify: `src/services/anthropic.service.ts`
- Test: no existing spec for this service today. We add one failing unit test to pin the new behavior down; if the codebase doesn't have an `anthropic.service.spec.ts` file yet, we create it minimally.

- [ ] **Step 1: Check whether `anthropic.service.spec.ts` exists; if not, create a minimal test harness**

Run: `ls src/services/anthropic.service.spec.ts 2>/dev/null || echo "missing"`

If missing, create `src/services/anthropic.service.spec.ts` with a basic mock-SDK setup. If it exists, jump to Step 2 and append to the existing `describe`.

Minimal new file content (only create if file is missing):

```ts
import { Test, TestingModule } from "@nestjs/testing";

import { AnthropicService } from "./anthropic.service";
import { AnthropicConfigService } from "./anthropic-config.service";

const mockClient = {
  messages: {
    create: jest.fn(),
  },
};

jest.mock("@anthropic-ai/sdk", () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => mockClient),
  };
});

const mockAnthropicConfig: Partial<AnthropicConfigService> = {
  apiKey: "sk-test",
  model: "claude-sonnet-4-6",
};

describe("AnthropicService", () => {
  let service: AnthropicService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockClient.messages.create.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnthropicService,
        { provide: AnthropicConfigService, useValue: mockAnthropicConfig },
      ],
    }).compile();

    service = module.get<AnthropicService>(AnthropicService);
  });

  // test blocks appended in Step 2
});
```

- [ ] **Step 2: Add failing tests for the new `dynamicSystemContext` argument**

Append inside the `describe("AnthropicService", ...)` block:

```ts
  it("passes only the cached static prefix when dynamicSystemContext is omitted", async () => {
    await service.sendMessage([{ role: "user", content: [{ type: "text", text: "hi" }] }], [], "STATIC_PREFIX");

    const call = mockClient.messages.create.mock.calls[0][0];
    expect(call.system).toEqual([
      { type: "text", text: "STATIC_PREFIX", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("appends an uncached second system block when dynamicSystemContext is provided", async () => {
    await service.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      [],
      "STATIC_PREFIX",
      "User context: budget = $1,000",
    );

    const call = mockClient.messages.create.mock.calls[0][0];
    expect(call.system).toEqual([
      { type: "text", text: "STATIC_PREFIX", cache_control: { type: "ephemeral" } },
      { type: "text", text: "User context: budget = $1,000" },
    ]);
  });

  it("does not attach cache_control to the dynamic block", async () => {
    await service.sendMessage(
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      [],
      "STATIC_PREFIX",
      "DYNAMIC",
    );

    const call = mockClient.messages.create.mock.calls[0][0];
    expect(call.system[1]).not.toHaveProperty("cache_control");
  });
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `npx jest src/services/anthropic.service.spec.ts --no-coverage`

Expected: third argument test passes (existing behavior); the two new tests FAIL because `sendMessage` has no fourth parameter.

- [ ] **Step 4: Update `AnthropicService.sendMessage` to accept the new argument**

Edit `src/services/anthropic.service.ts`. Change the `sendMessage` signature and the system-block construction:

Replace:

```ts
  async sendMessage(
    messages: ChatSessionMessage[],
    tools: ChatToolDefinition[],
    systemPrompt?: string,
  ): Promise<ChatAnthropicResponse> {
```

With:

```ts
  async sendMessage(
    messages: ChatSessionMessage[],
    tools: ChatToolDefinition[],
    systemPrompt?: string,
    dynamicSystemContext?: string,
  ): Promise<ChatAnthropicResponse> {
```

Replace the `cachedSystem` construction:

```ts
    const cachedSystem: Anthropic.TextBlockParam[] | undefined = systemPrompt
      ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
      : undefined;
```

With:

```ts
    // The first block carries cache_control and is the cached static prefix
    // (system prompt + tool schemas). Any dynamic per-session context (e.g.
    // the visitor's budget) goes in a second, uncached text block so it does
    // not invalidate the cache on the static prefix.
    const systemBlocks: Anthropic.TextBlockParam[] = [];

    if (systemPrompt) {
      systemBlocks.push({ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } });
    }

    if (dynamicSystemContext) {
      systemBlocks.push({ type: "text", text: dynamicSystemContext });
    }

    const cachedSystem: Anthropic.TextBlockParam[] | undefined = systemBlocks.length > 0 ? systemBlocks : undefined;
```

- [ ] **Step 5: Run the tests to confirm green**

Run: `npx jest src/services/anthropic.service.spec.ts --no-coverage`

Expected: all three tests PASS.

- [ ] **Step 6: Commit Tasks 2 + 3**

```bash
git add src/validation/web-chat.schema.ts src/services/anthropic.service.ts src/services/anthropic.service.spec.ts
git commit -m "feat(anthropic): accept uncached dynamicSystemContext alongside cached prefix"
```

---

### Task 4: `IdentityService.lookupOrCreateSession` — return metadata

**Files:**
- Modify: `src/services/identity.service.ts`
- Test: `src/services/identity.service.spec.ts`

- [ ] **Step 1: Read the existing `identity.service.spec.ts` to understand the mock shape**

Run: `head -60 src/services/identity.service.spec.ts`

Note how `mockClient.on(GetCommand).resolves({...})` is used. You'll need to add a second `GetCommand` mock for the METADATA read on the existing-session path.

- [ ] **Step 2: Rewrite the return-type contract failing tests**

Existing tests in `identity.service.spec.ts` assert `lookupOrCreateSession` returns a bare `string`. Update them to expect `{ sessionUlid, onboardingCompletedAt, budgetCents }`. Pick the **3 most load-bearing tests** (new session created; existing session found; race-condition recovery) and update each. Leave any other tests alone — only change the return-value shape assertions.

For each targeted test, change:

```ts
const sessionUlid = await service.lookupOrCreateSession(...);
expect(sessionUlid).toBe(EXPECTED_ULID);
```

To:

```ts
const result = await service.lookupOrCreateSession(...);
expect(result).toEqual({ sessionUlid: EXPECTED_ULID, onboardingCompletedAt: null, budgetCents: null });
```

For the **existing-session** test specifically, stage the DynamoDB mock to also return a METADATA record on the second `GetCommand` call, with onboarding fields set. Add the expectation that those values come through:

```ts
ddbMock
  .on(GetCommand)
  .resolvesOnce({ Item: { /* identity record with session_id */ } })
  .resolvesOnce({
    Item: {
      PK: `CHAT_SESSION#${EXISTING_SESSION_ULID}`,
      SK: "METADATA",
      onboarding_completed_at: "2026-04-19T20:00:00.000Z",
      budget_cents: 100_000,
    },
  });

const result = await service.lookupOrCreateSession(/* ... */);

expect(result).toEqual({
  sessionUlid: EXISTING_SESSION_ULID,
  onboardingCompletedAt: "2026-04-19T20:00:00.000Z",
  budgetCents: 100_000,
});
```

- [ ] **Step 3: Run the targeted tests to confirm they fail**

Run: `npx jest src/services/identity.service.spec.ts --no-coverage`

Expected: the 3 updated tests FAIL (return value is a string today, not an object).

- [ ] **Step 4: Update `identity.service.ts` return type and logic**

Change the return type of `lookupOrCreateSession` from `Promise<string>` to `Promise<{ sessionUlid: string; onboardingCompletedAt: string | null; budgetCents: number | null }>`.

For the **existing-session** path (after `if (existingResult.Item)`), replace:

```ts
if (existingResult.Item) {
  const sessionUlid: string = existingResult.Item.session_id;

  this.logger.debug(`Found existing session [sessionUlid=${sessionUlid} source=${source} externalId=${externalId}]`);

  return sessionUlid;
}
```

With:

```ts
if (existingResult.Item) {
  const sessionUlid: string = existingResult.Item.session_id;

  this.logger.debug(`Found existing session [sessionUlid=${sessionUlid} source=${source} externalId=${externalId}]`);

  const metadataResult = await this.dynamoDb.send(
    new GetCommand({
      TableName: table,
      Key: { PK: `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`, SK: METADATA_SK },
    }),
  );

  const onboardingCompletedAt = metadataResult.Item?.onboarding_completed_at ?? null;
  const budgetCents = metadataResult.Item?.budget_cents ?? null;

  return { sessionUlid, onboardingCompletedAt, budgetCents };
}
```

For the **new-session** path (the final `return sessionUlid;` at the bottom), replace with:

```ts
return { sessionUlid, onboardingCompletedAt: null, budgetCents: null };
```

For the **race-recovery** path inside the `catch (error)` block, replace:

```ts
return winnerSessionUlid;
```

With:

```ts
return { sessionUlid: winnerSessionUlid, onboardingCompletedAt: null, budgetCents: null };
```

(A recovering caller gets nulls — the METADATA may not be readable atomically with identity recovery, and the worst case is the frontend shows an extra splash. Acceptable trade-off; not worth a second GetItem on the race path.)

- [ ] **Step 5: Run the full service spec**

Run: `npx jest src/services/identity.service.spec.ts --no-coverage`

Expected: all tests PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/services/identity.service.ts src/services/identity.service.spec.ts
git commit -m "feat(identity): return onboarding metadata with session lookup"
```

---

### Task 5: `ChatSessionService` — inject budget + expose history

**Files:**
- Modify: `src/services/chat-session.service.ts`
- Test: `src/services/chat-session.service.spec.ts`

- [ ] **Step 1: Add failing test for budget injection into Anthropic call**

In `src/services/chat-session.service.spec.ts`, find the existing `AnthropicService` mock and append a new test inside the main `describe`:

```ts
  it("passes a dynamic system context with budget when budget_cents is set on METADATA", async () => {
    // Stage METADATA to include budget_cents; stage history empty; stage Anthropic to end_turn immediately.
    ddbMock
      .on(GetCommand, {
        Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" },
      })
      .resolves({
        Item: {
          PK: `CHAT_SESSION#${SESSION_ULID}`,
          SK: "METADATA",
          agent_name: "shopping_assistant",
          budget_cents: 100_000, // $1,000
        },
      });

    ddbMock.on(QueryCommand).resolves({ Items: [] });

    mockAnthropicService.sendMessage.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    });

    await service.handleMessage(SESSION_ULID, "hello");

    expect(mockAnthropicService.sendMessage).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Array),
      expect.any(String),
      "User context: shopping budget is approximately $1000.",
    );
  });

  it("omits the dynamic system context when budget_cents is not set", async () => {
    ddbMock
      .on(GetCommand, { Key: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA" } })
      .resolves({ Item: { PK: `CHAT_SESSION#${SESSION_ULID}`, SK: "METADATA", agent_name: "shopping_assistant" } });

    ddbMock.on(QueryCommand).resolves({ Items: [] });

    mockAnthropicService.sendMessage.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    });

    await service.handleMessage(SESSION_ULID, "hello");

    const call = mockAnthropicService.sendMessage.mock.calls[0];
    expect(call[3]).toBeUndefined();
  });
```

(Constants like `SESSION_ULID` and mock setup should already exist in the spec. If not present, lift the existing spec's conventions — look at how other tests set up `ddbMock` and `mockAnthropicService`.)

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npx jest src/services/chat-session.service.spec.ts --no-coverage`

Expected: the two new tests FAIL.

- [ ] **Step 3: Update `handleMessage` to read budget and pass it through**

In `src/services/chat-session.service.ts`, find the block starting at line 66 (the current METADATA read). After the existing `const accountUlid = metadataResult.Item?.account_id;` line, add:

```ts
      const budgetCents: number | undefined = metadataResult.Item?.budget_cents;
```

Then, find the Anthropic call (around line 139):

```ts
const response = await this.anthropicService.sendMessage([...messages], filteredDefinitions, agent.systemPrompt);
```

Replace with:

```ts
const dynamicSystemContext = budgetCents !== undefined && budgetCents !== null
  ? `User context: shopping budget is approximately $${Math.floor(budgetCents / 100)}.`
  : undefined;

const response = await this.anthropicService.sendMessage(
  [...messages],
  filteredDefinitions,
  agent.systemPrompt,
  dynamicSystemContext,
);
```

- [ ] **Step 4: Add failing tests for the new `getHistoryForClient` method**

Append to `chat-session.service.spec.ts`:

```ts
  describe("getHistoryForClient", () => {
    it("filters out user records whose content is only tool_result blocks", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          {
            PK: `CHAT_SESSION#${SESSION_ULID}`,
            SK: "MESSAGE#01TEXTUSER00000000000000000",
            role: "user",
            content: JSON.stringify([{ type: "text", text: "Hi" }]),
            _createdAt_: "2026-04-19T20:00:00.000Z",
          },
          {
            PK: `CHAT_SESSION#${SESSION_ULID}`,
            SK: "MESSAGE#01TOOLRESULT00000000000000",
            role: "user",
            content: JSON.stringify([{ type: "tool_result", tool_use_id: "x", content: "{}" }]),
            _createdAt_: "2026-04-19T20:00:01.000Z",
          },
          {
            PK: `CHAT_SESSION#${SESSION_ULID}`,
            SK: "MESSAGE#01ASSISTANT00000000000000",
            role: "assistant",
            content: JSON.stringify([
              { type: "text", text: "Hello!" },
              { type: "tool_use", id: "x", name: "foo", input: {} },
            ]),
            _createdAt_: "2026-04-19T20:00:02.000Z",
          },
          {
            PK: `CHAT_SESSION#${SESSION_ULID}`,
            SK: "MESSAGE#01ASSISTANTNOTEXT000000000",
            role: "assistant",
            content: JSON.stringify([{ type: "tool_use", id: "y", name: "foo", input: {} }]),
            _createdAt_: "2026-04-19T20:00:03.000Z",
          },
        ],
      });

      const history = await service.getHistoryForClient(SESSION_ULID);

      expect(history).toEqual([
        { id: "01TEXTUSER00000000000000000", role: "user", content: "Hi", timestamp: "2026-04-19T20:00:00.000Z" },
        { id: "01ASSISTANT00000000000000", role: "assistant", content: "Hello!", timestamp: "2026-04-19T20:00:02.000Z" },
      ]);
    });

    it("returns an empty array when no messages exist", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const history = await service.getHistoryForClient(SESSION_ULID);

      expect(history).toEqual([]);
    });

    it("queries messages in ascending chronological order", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await service.getHistoryForClient(SESSION_ULID);

      const call = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
      expect(call.KeyConditionExpression).toBe("PK = :pk AND begins_with(SK, :skPrefix)");
      expect(call.ExpressionAttributeValues?.[":pk"]).toBe(`CHAT_SESSION#${SESSION_ULID}`);
      expect(call.ExpressionAttributeValues?.[":skPrefix"]).toBe("MESSAGE#");
      expect(call.ScanIndexForward).toBe(true);
    });
  });
```

- [ ] **Step 5: Run the tests to confirm the new `getHistoryForClient` suite fails**

Run: `npx jest src/services/chat-session.service.spec.ts -t "getHistoryForClient" --no-coverage`

Expected: all three tests FAIL with `service.getHistoryForClient is not a function`.

- [ ] **Step 6: Implement `getHistoryForClient`**

Add the following import at the top of `src/services/chat-session.service.ts` (alongside the existing type imports):

```ts
import { WebChatHistoryMessage } from "../types/WebChat";
```

Add the following public method to the `ChatSessionService` class (after `handleMessage`):

```ts
  async getHistoryForClient(sessionUlid: string): Promise<WebChatHistoryMessage[]> {
    const table = this.databaseConfig.conversationsTable;
    const sessionPk = `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`;

    const result = await this.dynamoDb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": sessionPk,
          ":skPrefix": MESSAGE_SK_PREFIX,
        },
        ScanIndexForward: true,
      }),
    );

    const items = result.Items ?? [];

    const history: WebChatHistoryMessage[] = [];

    for (const item of items) {
      const role = item.role;

      if (role !== "user" && role !== "assistant") {
        continue;
      }

      let blocks: ChatContentBlock[];

      try {
        blocks = JSON.parse(item.content);
      } catch {
        // Legacy plain-string content: treat the whole string as one text block.
        blocks = [{ type: "text", text: item.content }];
      }

      const textParts: string[] = [];

      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        }
      }

      const content = textParts.join("\n\n").trim();

      if (!content) {
        continue;
      }

      const id = typeof item.SK === "string" && item.SK.startsWith(MESSAGE_SK_PREFIX)
        ? item.SK.slice(MESSAGE_SK_PREFIX.length)
        : item.SK;

      history.push({
        id,
        role,
        content,
        timestamp: item._createdAt_,
      });
    }

    return history;
  }
```

- [ ] **Step 7: Run the full service spec**

Run: `npx jest src/services/chat-session.service.spec.ts --no-coverage`

Expected: all tests PASS (existing `handleMessage` tests + new budget injection tests + new `getHistoryForClient` tests).

- [ ] **Step 8: Commit Task 5**

```bash
git add src/services/chat-session.service.ts src/services/chat-session.service.spec.ts
git commit -m "feat(chat-session): inject budget context and expose filtered history"
```

---

### Task 6: Controller — update `createSession` response, add onboarding + messages endpoints

**Files:**
- Modify: `src/controllers/web-chat.controller.ts`
- Test: `src/controllers/web-chat.controller.spec.ts`

- [ ] **Step 1: Update existing `createSession` tests to expect the new response shape**

In `src/controllers/web-chat.controller.spec.ts`, update the `mockOriginAllowlistService` mock to return the new `lookupOrCreateSession` shape. Change:

```ts
const mockIdentityService = {
  lookupOrCreateSession: jest.fn(),
};
```

Leave that as-is but update every test that does `mockIdentityService.lookupOrCreateSession.mockResolvedValue(VALID_SESSION_ULID)`. Replace each occurrence with:

```ts
mockIdentityService.lookupOrCreateSession.mockResolvedValue({
  sessionUlid: VALID_SESSION_ULID,
  onboardingCompletedAt: null,
  budgetCents: null,
});
```

Then update the passing-createSession test to assert the new response fields:

```ts
    it("returns sessionUlid, displayName, and onboarding nulls for a new session", async () => {
      mockAgentRegistry.getByName.mockReturnValue({ name: AGENT_NAME, displayName: "Lead Capture Assistant" });
      mockIdentityService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: VALID_SESSION_ULID,
        onboardingCompletedAt: null,
        budgetCents: null,
      });

      const result = await controller.createSession({
        agentName: AGENT_NAME,
        guestUlid: VALID_GUEST_ULID,
        accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
      });

      expect(result).toEqual({
        sessionUlid: VALID_SESSION_ULID,
        displayName: "Lead Capture Assistant",
        onboardingCompletedAt: null,
        budgetCents: null,
      });
    });

    it("echoes onboardingCompletedAt and budgetCents from IdentityService for a returning session", async () => {
      mockAgentRegistry.getByName.mockReturnValue({ name: AGENT_NAME, displayName: "Lead Capture Assistant" });
      mockIdentityService.lookupOrCreateSession.mockResolvedValue({
        sessionUlid: VALID_SESSION_ULID,
        onboardingCompletedAt: "2026-04-19T20:00:00.000Z",
        budgetCents: 100_000,
      });

      const result = await controller.createSession({
        agentName: AGENT_NAME,
        guestUlid: VALID_GUEST_ULID,
        accountUlid: VALID_ACCOUNT_ULID_WITH_PREFIX,
      });

      expect(result.onboardingCompletedAt).toBe("2026-04-19T20:00:00.000Z");
      expect(result.budgetCents).toBe(100_000);
    });
```

- [ ] **Step 2: Run the controller spec to confirm the old shape fails**

Run: `npx jest src/controllers/web-chat.controller.spec.ts --no-coverage`

Expected: the updated `createSession` tests FAIL (response doesn't include `onboardingCompletedAt` / `budgetCents` yet).

- [ ] **Step 3: Update `createSession` to echo the new fields**

In `src/controllers/web-chat.controller.ts`, replace the `createSession` body after the `verifyAccountActive` check. Change:

```ts
    const sessionUlid = await this.identityService.lookupOrCreateSession("web", body.guestUlid, body.agentName, accountUlid);
    const displayName = agent.displayName ?? agent.name;

    this.logger.debug(
      `Session created [agentName=${body.agentName} sessionUlid=${sessionUlid} accountUlid=${accountUlid} source=accountUlid]`,
    );

    return { sessionUlid, displayName };
```

To:

```ts
    const sessionResult = await this.identityService.lookupOrCreateSession(
      "web",
      body.guestUlid,
      body.agentName,
      accountUlid,
    );

    const displayName = agent.displayName ?? agent.name;

    this.logger.debug(
      `Session created [agentName=${body.agentName} sessionUlid=${sessionResult.sessionUlid} accountUlid=${accountUlid} source=accountUlid]`,
    );

    return {
      sessionUlid: sessionResult.sessionUlid,
      displayName,
      onboardingCompletedAt: sessionResult.onboardingCompletedAt,
      budgetCents: sessionResult.budgetCents,
    };
```

- [ ] **Step 4: Re-run existing controller tests to confirm green**

Run: `npx jest src/controllers/web-chat.controller.spec.ts --no-coverage`

Expected: all existing tests PASS (including the updated ones).

- [ ] **Step 5: Add failing tests for the onboarding endpoint**

Append inside the existing `describe("WebChatController", ...)`:

```ts
  describe("POST /sessions/:sessionUlid/onboarding", () => {
    const SESSION_ULID = VALID_SESSION_ULID;

    it("updates the METADATA record with budget_cents + onboarding_completed_at and returns the full session shape", async () => {
      mockAgentRegistry.getByName.mockReturnValue({ name: AGENT_NAME, displayName: "Lead Capture Assistant" });
      mockIdentityService.updateOnboarding = jest.fn().mockResolvedValue({
        sessionUlid: SESSION_ULID,
        onboardingCompletedAt: "2026-04-19T20:00:00.000Z",
        budgetCents: 100_000,
      });

      const result = await controller.completeOnboarding(SESSION_ULID, { budgetCents: 100_000 });

      expect(result).toEqual({
        sessionUlid: SESSION_ULID,
        displayName: expect.any(String),
        onboardingCompletedAt: "2026-04-19T20:00:00.000Z",
        budgetCents: 100_000,
      });

      expect(mockIdentityService.updateOnboarding).toHaveBeenCalledWith(SESSION_ULID, 100_000);
    });

    it("pipe rejects non-integer budgetCents", () => {
      const pipe = new ZodValidationPipe(onboardingSchema);
      expect(() => pipe.transform({ budgetCents: 1.5 })).toThrow(BadRequestException);
    });

    it("pipe rejects negative or zero budgetCents", () => {
      const pipe = new ZodValidationPipe(onboardingSchema);
      expect(() => pipe.transform({ budgetCents: 0 })).toThrow(BadRequestException);
      expect(() => pipe.transform({ budgetCents: -100 })).toThrow(BadRequestException);
    });

    it("pipe rejects budgetCents over the $1M cap", () => {
      const pipe = new ZodValidationPipe(onboardingSchema);
      expect(() => pipe.transform({ budgetCents: 100_000_001 })).toThrow(BadRequestException);
    });

    it("param pipe rejects invalid sessionUlid", () => {
      const pipe = new ZodValidationPipe(sessionUlidParamSchema);
      expect(() => pipe.transform("not-a-ulid")).toThrow(BadRequestException);
    });
  });
```

At the top of the spec, add imports for `onboardingSchema` + `sessionUlidParamSchema`:

```ts
import { createSessionSchema, sendMessageSchema, onboardingSchema, sessionUlidParamSchema } from "../validation/web-chat.schema";
```

- [ ] **Step 6: Add `updateOnboarding` to `IdentityService`**

Edit `src/services/identity.service.ts`. Add a new public method:

```ts
  async updateOnboarding(sessionUlid: string, budgetCents: number): Promise<{ sessionUlid: string; onboardingCompletedAt: string; budgetCents: number }> {
    const table = this.databaseConfig.conversationsTable;
    const sessionPk = `${CHAT_SESSION_PK_PREFIX}${sessionUlid}`;
    const now = new Date().toISOString();

    await this.dynamoDb.send(
      new UpdateCommand({
        TableName: table,
        Key: { PK: sessionPk, SK: METADATA_SK },
        UpdateExpression: "SET onboarding_completed_at = :now, budget_cents = :cents, #lastUpdated = :now",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeNames: { "#lastUpdated": "_lastUpdated_" },
        ExpressionAttributeValues: { ":now": now, ":cents": budgetCents },
      }),
    );

    this.logger.debug(`Onboarding recorded [sessionUlid=${sessionUlid} budgetCents=${budgetCents}]`);

    return { sessionUlid, onboardingCompletedAt: now, budgetCents };
  }
```

- [ ] **Step 7: Add the onboarding route handler to the controller**

Edit `src/controllers/web-chat.controller.ts`. Add imports at the top:

```ts
import { BadRequestException, Body, Controller, Get, InternalServerErrorException, Logger, NotFoundException, Param, Post } from "@nestjs/common";
```

Also add to the schema import:

```ts
import { createSessionSchema, onboardingSchema, sendMessageSchema, sessionUlidParamSchema } from "../validation/web-chat.schema";
import type { CreateSessionBody, OnboardingBody, SendMessageBody } from "../validation/web-chat.schema";
```

Add the `WebChatOnboardingResponse` import:

```ts
import {
  WebChatCreateSessionResponse,
  WebChatMessagesResponse,
  WebChatOnboardingResponse,
  WebChatSendMessageResponse,
} from "../types/WebChat";
```

Inject `AgentRegistryService` stays; displayName resolution for the onboarding response needs the agent, so we'll need to re-fetch the agent from METADATA or change the response shape. **Simplification:** make `completeOnboarding`'s response a subset — drop `displayName`. The frontend already has it from `createSession`. Update the `WebChatOnboardingResponse` type in Task 1's edit file accordingly:

In `src/types/WebChat.ts`, change:

```ts
export type WebChatOnboardingResponse = WebChatCreateSessionResponse;
```

To:

```ts
export interface WebChatOnboardingResponse {
  sessionUlid: string;
  onboardingCompletedAt: string;
  budgetCents: number;
}
```

Update the onboarding test in Step 5 accordingly — remove the `displayName: expect.any(String)` line. Expected shape is:

```ts
expect(result).toEqual({
  sessionUlid: SESSION_ULID,
  onboardingCompletedAt: "2026-04-19T20:00:00.000Z",
  budgetCents: 100_000,
});
```

Add the controller method:

```ts
  @Post(":sessionUlid/onboarding")
  async completeOnboarding(
    @Param("sessionUlid", new ZodValidationPipe(sessionUlidParamSchema)) sessionUlid: string,
    @Body(new ZodValidationPipe(onboardingSchema)) body: OnboardingBody,
  ): Promise<WebChatOnboardingResponse> {
    try {
      const result = await this.identityService.updateOnboarding(sessionUlid, body.budgetCents);

      this.logger.debug(`Onboarding completed [sessionUlid=${sessionUlid} budgetCents=${body.budgetCents}]`);

      return result;
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : "UnknownError";

      if (errorName === "ConditionalCheckFailedException") {
        throw new NotFoundException(`Session not found: ${sessionUlid}`);
      }

      this.logger.error(`Onboarding update failed [sessionUlid=${sessionUlid} errorType=${errorName}]`);
      throw new InternalServerErrorException("Failed to record onboarding.");
    }
  }
```

- [ ] **Step 8: Run onboarding tests to confirm green**

Run: `npx jest src/controllers/web-chat.controller.spec.ts --no-coverage`

Expected: onboarding tests PASS.

- [ ] **Step 9: Add failing tests for the messages GET endpoint**

Append inside `describe("WebChatController", ...)`:

```ts
  describe("GET /sessions/:sessionUlid/messages", () => {
    it("returns the filtered history from ChatSessionService", async () => {
      const history = [
        { id: "01AAAAAAAAAAAAAAAAAAAAAAAA", role: "user" as const, content: "Hi", timestamp: "2026-04-19T20:00:00.000Z" },
        { id: "01BBBBBBBBBBBBBBBBBBBBBBBB", role: "assistant" as const, content: "Hello!", timestamp: "2026-04-19T20:00:01.000Z" },
      ];

      mockChatSessionService.getHistoryForClient = jest.fn().mockResolvedValue(history);

      const result = await controller.getMessages(VALID_SESSION_ULID);

      expect(result).toEqual({ messages: history });
      expect(mockChatSessionService.getHistoryForClient).toHaveBeenCalledWith(VALID_SESSION_ULID);
    });

    it("returns an empty messages array when no history exists", async () => {
      mockChatSessionService.getHistoryForClient = jest.fn().mockResolvedValue([]);

      const result = await controller.getMessages(VALID_SESSION_ULID);

      expect(result).toEqual({ messages: [] });
    });
  });
```

- [ ] **Step 10: Add the messages GET handler to the controller**

```ts
  @Get(":sessionUlid/messages")
  async getMessages(
    @Param("sessionUlid", new ZodValidationPipe(sessionUlidParamSchema)) sessionUlid: string,
  ): Promise<WebChatMessagesResponse> {
    const messages = await this.chatSessionService.getHistoryForClient(sessionUlid);
    return { messages };
  }
```

- [ ] **Step 11: Fix the controller route base**

The controller is declared `@Controller("chat/web")` with `@Post("sessions")` on `createSession`. The new routes need the `sessions/` prefix:

- `@Post(":sessionUlid/onboarding")` → becomes `/chat/web/:sessionUlid/onboarding` (wrong)
- We want `/chat/web/sessions/:sessionUlid/onboarding`.

Change the decorators on the two new handlers to:

```ts
  @Post("sessions/:sessionUlid/onboarding")
```

and

```ts
  @Get("sessions/:sessionUlid/messages")
```

Verify by looking at the existing `@Post("sessions")` — the routes resolve relative to the controller's base `chat/web`, so `sessions/:x/y` resolves to `/chat/web/sessions/:x/y`. Good.

- [ ] **Step 12: Run the full controller spec**

Run: `npx jest src/controllers/web-chat.controller.spec.ts --no-coverage`

Expected: all tests PASS.

- [ ] **Step 13: Run `tsc` and the full suite**

Run: `npx tsc --noEmit && npm test`

Expected: zero type errors; all suites PASS.

- [ ] **Step 14: Commit Task 6**

```bash
git add src/controllers/web-chat.controller.ts src/controllers/web-chat.controller.spec.ts src/services/identity.service.ts src/services/identity.service.spec.ts src/types/WebChat.ts
git commit -m "feat(web-chat): add onboarding + messages endpoints; echo onboarding state on session create"
```

---

### Task 7: Local smoke test

**Files:** none modified.

- [ ] **Step 1: Start the dev server**

Run: `npm run start:dev`

- [ ] **Step 2: Create a session (expect nulls on onboarding)**

```bash
curl -sS -X POST http://localhost:8081/chat/web/sessions \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"agentName":"shopping_assistant","guestUlid":"01ARZ3NDEKTSV4RRFFQ69G5FAV","accountUlid":"A#<REAL_ACTIVE_ULID>"}' | jq
```

Expected: JSON body with `sessionUlid`, `displayName`, `onboardingCompletedAt: null`, `budgetCents: null`. Copy the `sessionUlid` for the next step.

- [ ] **Step 3: Call onboarding**

```bash
curl -sS -X POST http://localhost:8081/chat/web/sessions/<SESSION_ULID>/onboarding \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"budgetCents":100000}' | jq
```

Expected: `{ sessionUlid, onboardingCompletedAt: "<ISO now>", budgetCents: 100000 }`.

- [ ] **Step 4: Re-create the session (same guestUlid + accountUlid) — onboarding fields should now be populated**

Re-run the Step 2 curl. Expected: same `sessionUlid`, now `onboardingCompletedAt` is the ISO timestamp from Step 3 and `budgetCents: 100000`.

- [ ] **Step 5: Send a chat message and confirm the budget note appears in the Anthropic call**

```bash
curl -sS -X POST http://localhost:8081/chat/web/messages \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"sessionUlid":"<SESSION_ULID>","message":"hi"}' | jq
```

Expected: a chat reply. In the backend logs look for the `AnthropicService` debug line; a cache-hit on the static prefix with `cacheRead=2734` and a slightly higher `input_tokens` than baseline (the dynamic budget block adds ~15 tokens, uncached).

- [ ] **Step 6: Fetch message history**

```bash
curl -sS -X GET http://localhost:8081/chat/web/sessions/<SESSION_ULID>/messages \
  -H "Origin: http://localhost:3000" | jq
```

Expected: `{ messages: [{ id, role: "user", content: "hi", timestamp }, { id, role: "assistant", content: "<reply>", timestamp }] }`. No tool-use or tool-result entries.

- [ ] **Step 7: Verify invalid inputs**

```bash
# Non-integer cents
curl -i -X POST http://localhost:8081/chat/web/sessions/<SESSION_ULID>/onboarding \
  -H "Content-Type: application/json" -H "Origin: http://localhost:3000" \
  -d '{"budgetCents":1.5}'
# Expected: 400

# Unknown session
curl -i -X POST http://localhost:8081/chat/web/sessions/00000000000000000000000000/onboarding \
  -H "Content-Type: application/json" -H "Origin: http://localhost:3000" \
  -d '{"budgetCents":50000}'
# Expected: 404
```

- [ ] **Step 8: Stop the dev server. No commit for this task.**

---

## Self-Review Checklist

- [ ] Spec coverage: onboarding fields on create-session response (Task 1 types + Task 6 controller); onboarding POST endpoint (Task 2 schema + Task 6 controller + IdentityService.updateOnboarding); messages GET endpoint (Task 5 service + Task 6 controller); budget injection into Anthropic calls (Task 3 + Task 5).
- [ ] Method/property naming consistency: `onboardingCompletedAt` on the wire, `onboarding_completed_at` in DynamoDB; `budgetCents` on the wire, `budget_cents` in DynamoDB. Used consistently across all tasks.
- [ ] No placeholders. Every step has concrete code.
- [ ] `AnthropicService` cache behavior preserved — only the first block carries `cache_control`; the dynamic block is appended without invalidating the static prefix.
- [ ] Controller routes use full `sessions/:sessionUlid/...` path relative to the `chat/web` base.
- [ ] Deferred work (Referer/CSP, welcome turn, allowedEmbedOrigins) is explicitly out of scope.
