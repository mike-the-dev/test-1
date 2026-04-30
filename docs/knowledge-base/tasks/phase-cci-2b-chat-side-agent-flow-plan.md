# Phase CCI-2b — Cross-channel identity: chat-side agent flow
# Implementation Plan

---

## Overview

This phase composes the substrate from CCI-1 and CCI-2a into the actual chat-side returning-visitor experience. Three connected changes ship together: (1) `verify_code` is extended to capture the customer's prior `latest_session_id` into a new METADATA field (`continuation_from_session_id`) atomically with the existing `customer_id` write, before Write B overwrites the pointer on the Customer record; (2) a prior-history loader is wired into `handleMessage` in `chat-session.service.ts` — it fires at most once per session for verified sessions, reads the Customer profile and the last 20 messages from the captured prior session, then passes visitor profile + framing context through the existing `dynamicSystemContext` parameter of `AnthropicService.sendMessage` while prepending only real prior-session turns to the messages array; (3) `lead_capture.agent.ts` and `shopping_assistant.agent.ts` receive a new RETURNING VISITOR FLOW section that gives the agent its complete behavioral contract for the verification handoff and graceful failure path.

### Key architectural fact confirmed during planning

`AnthropicService.sendMessage` already accepts a `dynamicSystemContext?: string` parameter and already builds the `system` parameter as an array of `Anthropic.TextBlockParam` blocks — with `cache_control: { type: "ephemeral" }` on the static base prompt block and the dynamic block appended without a cache marker. This is the exact Option B structure described in the brief. **The loader does not need to touch `anthropic.service.ts` at all.** It simply constructs a string and passes it as `dynamicSystemContext` at the `sendMessage` call site in `chat-session.service.ts`. The messages array stays clean: only real visitor/agent turns, no synthetic role:user metadata injections.

---

## Affected Files and Modules

### Modify

| File | Change |
|------|--------|
| `src/types/ChatSession.ts` | Add `continuation_from_session_id: string \| null` and `continuation_loaded_at: string \| null` to `ChatSessionMetadataRecord` |
| `src/services/identity.service.ts` | Initialise both new fields as `null` in the METADATA UpdateCommand at session creation |
| `src/services/customer.service.ts` | Extend `queryCustomerIdByEmail` return type from `Promise<string \| null>` to `Promise<{ customerUlid: string; latestSessionId: string \| null } \| null>` |
| `src/services/customer.service.spec.ts` | Update all existing `queryCustomerIdByEmail` test assertions to expect the new return shape; add 4 new cases |
| `src/tools/collect-contact-info.tool.ts` | Verify the tool calls `lookupOrCreateCustomer`, NOT `queryCustomerIdByEmail` directly; update `lookupOrCreateCustomer`'s internal callers in `customer.service.ts` instead |
| `src/tools/collect-contact-info.tool.spec.ts` | Verify mocks are for `lookupOrCreateCustomer`; update if any direct `queryCustomerIdByEmail` mock exists |
| `src/tools/verify-code.tool.ts` | Extend Write A to also set `continuation_from_session_id`; destructure `latestSessionId` from the extended `queryCustomerIdByEmail` result before Write B fires |
| `src/tools/verify-code.tool.spec.ts` | Update `mockCustomerService.queryCustomerIdByEmail` mock returns to new shape; add test cases for new Write A field |
| `src/services/chat-session.service.ts` | Wire the prior-history loader before the `sendMessage` call; build `dynamicSystemContext` string with visitor profile + framing; prepend prior session turns to `messages`; issue `continuation_loaded_at` UpdateCommand |
| `src/services/chat-session.service.spec.ts` | Add loader gate tests, loader output tests, idempotency tests, failure-path tests |
| `src/agents/lead-capture.agent.ts` | Append RETURNING VISITOR FLOW section to `systemPrompt` |
| `src/agents/shopping-assistant.agent.ts` | Append RETURNING VISITOR FLOW section to `systemPrompt` |

### Review Only (no change)

| File | Reason |
|------|--------|
| `src/services/anthropic.service.ts` | Already supports `system` as a two-block array with `cache_control`. The `dynamicSystemContext` parameter is exactly the hook the loader uses. No change needed. |
| `src/tools/preview-cart.tool.ts` | `queryCustomerIdByEmail` no longer called here after Phase 2a; no change needed |
| `src/validation/tool.schema.ts` | No new tool schemas; existing `verifyCodeInputSchema` unchanged |
| `src/app.module.ts` | All providers already registered in Phase 1 and 2a; no change needed |

---

## Schema Additions

### A. `ChatSessionMetadataRecord` in `src/types/ChatSession.ts`

Add two fields immediately after `customer_id`:

```typescript
// Stamped by verify_code on success. Stores the bare session ULID that was in
// customer.latest_session_id at the moment of verification — i.e., the visitor's
// most-recent prior session, before this one. Null if verify_code was never called,
// if verification failed, or if the customer had no prior session (first return).
continuation_from_session_id: string | null;

// Stamped by the prior-history loader on its first fire in a session (ISO 8601).
// Non-null value is the gate that prevents the loader from firing a second time.
continuation_loaded_at: string | null;
```

Both fields must be explicitly typed (non-optional), matching the precedent set by `customer_id: string | null`.

### B. `identity.service.ts` METADATA UpdateCommand

The `setClauses` array already has:
```
"customer_id = if_not_exists(customer_id, :customerIdNull)"
```

Add two more SET clauses after `customer_id`:
```
"continuation_from_session_id = if_not_exists(continuation_from_session_id, :contFromNull)",
"continuation_loaded_at = if_not_exists(continuation_loaded_at, :contAtNull)",
```

Add corresponding values to `expressionValues`:
```typescript
":contFromNull": null,
":contAtNull": null,
```

Also update the `metadataItem` object (used in the `satisfies ChatSessionMetadataRecord` check) to include:
```typescript
continuation_from_session_id: null,
continuation_loaded_at: null,
```

### C. UpdateExpression shape for Write A in `verify_code`

The existing Write A expression:
```
"SET customer_id = :customerId, #lastUpdated = :now"
```

Becomes:
```
"SET customer_id = :customerId, continuation_from_session_id = :contFromSessionId, #lastUpdated = :now"
```

With additional ExpressionAttributeValues entry:
```typescript
":contFromSessionId": latestSessionId,  // bare session ULID or null
```

Where `latestSessionId` comes from the extended `queryCustomerIdByEmail` result (see verify_code modification below). Write A, Write B, and Write C are unchanged in order and mechanics — only Write A's UpdateExpression grows by one field.

---

## `CustomerService.queryCustomerIdByEmail` Return-Type Change

### Current return type
```typescript
Promise<string | null>
```

### New return type
```typescript
Promise<{ customerUlid: string; latestSessionId: string | null } | null>
```

`customerUlid` is the bare ULID (no `C#` prefix). `latestSessionId` is the bare session ULID read from the Customer record's `latest_session_id` attribute (stored without prefix per CCI-1 convention), or `null` if the field is absent or null.

### Implementation detail

The existing `QueryCommand` result returns the matching Customer record's attributes. The record already has `latest_session_id: string | null` (added in CCI-1). After extracting the ULID from `PK`:

```typescript
// New code:
const latestSessionId =
  items[0].latest_session_id != null ? String(items[0].latest_session_id) : null;
return { customerUlid: pk.slice(CUSTOMER_PK_PREFIX.length), latestSessionId };
```

The `null` case returns `null` (whole return) as before when no items exist or PK does not start with `C#`.

### Caller impact

**Caller 1 — internal calls inside `CustomerService.lookupOrCreateCustomer`**

`collect-contact-info.tool.ts` calls `lookupOrCreateCustomer`, not `queryCustomerIdByEmail` directly. `queryCustomerIdByEmail` is called internally inside `lookupOrCreateCustomer` in `customer.service.ts` at Step A and Step D (race recovery). Those internal call sites must be updated:

Step A:
```typescript
const lookupResult = await this.queryCustomerIdByEmail(input.tableName, input.accountUlid, input.email);
existingUlid = lookupResult ? lookupResult.customerUlid : null;
```

Step D:
```typescript
const recoveredResult = await this.queryCustomerIdByEmail(input.tableName, input.accountUlid, input.email);
recoveredUlid = recoveredResult ? recoveredResult.customerUlid : null;
```

`lookupOrCreateCustomer` itself is unaffected in its return shape — it still returns `{ isError, customerUlid, created }`. `collect-contact-info.tool.ts` sees no change.

**Caller 2 — `verify-code.tool.ts`**

The existing call:
```typescript
const lookedUpUlid = await this.customerService.queryCustomerIdByEmail(...);
if (lookedUpUlid === null) { ... }
customerUlid = lookedUpUlid;
```

Becomes:
```typescript
const lookupResult = await this.customerService.queryCustomerIdByEmail(...);
if (lookupResult === null) { ... }
customerUlid = lookupResult.customerUlid;
const latestSessionId = lookupResult.latestSessionId;  // bare session ULID or null
```

`latestSessionId` is then written into METADATA via Write A before Write B overwrites `customer.latest_session_id`.

**Compile safety:** All callers compile after this change because:
- `collect_contact_info` calls `lookupOrCreateCustomer`, not `queryCustomerIdByEmail` directly
- `verify_code` is updated as part of this phase
- `lookupOrCreateCustomer` internal calls are updated in `customer.service.ts`
- No other callers exist (confirmed by reading the codebase)

---

## Prior-History Loader Design

### Exact wiring point in `handleMessage`

The current `handleMessage` flow (actual line numbers from the read file):

```
1.  GetCommand — METADATA (line ~71)
2.  Resolve agent, filter tool definitions (lines ~87–107)
3.  Kickoff replay path (lines ~109–162, early-return if applicable)
4.  QueryCommand — current-session history (lines ~164–175)
5.  Build messages array: [...history, newUserMessage] (line 198)
6.  newMessages init (line 200)
7.  while (iteration < MAX_TOOL_LOOP_ITERATIONS) loop starts (line 204)
    Inside loop (first iteration, line 216):
      — build dynamicSystemContext (lines 211–214)
      — call this.anthropicService.sendMessage(messages, filteredDefinitions, agent.systemPrompt, dynamicSystemContext)
8.  Persist newMessages, UpdateCommands (lines ~272–370)
```

The loader inserts **between step 6 and step 7** — after `const newMessages = [newUserMessage]` (line 200) and before `let iteration = 0` (line 202). The loader reads gate values from `metadataResult.Item` (already in scope from step 1), conditionally performs two additional DDB reads, and may prepend prior session turns to `messages` and build an extended `dynamicSystemContext`.

**The `dynamicSystemContext` variable must be moved out of the tool loop** so the loader can set it. Currently it is declared inside the `while` loop on lines 211–214 (recalculated each iteration). After the refactor, it is declared once before the loop using `let`, computed by the loader if it fires, or set to the budget-only string if the loader does not fire. The tool loop then passes this pre-computed value to `sendMessage` unchanged on every iteration.

### Gate logic

```typescript
const continuationFromSessionId: string | null =
  metadataResult.Item?.continuation_from_session_id ?? null;
const continuationLoadedAt: string | null =
  metadataResult.Item?.continuation_loaded_at ?? null;

const shouldLoadContinuation =
  continuationFromSessionId !== null && continuationLoadedAt === null;
```

Both conditions must hold. If either fails, the loader does not run and the message array and `dynamicSystemContext` for Claude are built exactly as today.

### `dynamicSystemContext` initialisation (refactored)

The budget-context string that is currently built inside the `while` loop must be lifted out so the loader can extend it:

```typescript
// Before the loader block (and before the while loop):
const budgetContext =
  budgetCents !== undefined && budgetCents !== null
    ? `User context: shopping budget is approximately $${Math.floor(budgetCents / 100)}.`
    : undefined;

let dynamicSystemContext: string | undefined = budgetContext;
```

### Profile injection format — Option B: `dynamicSystemContext` string

**The loader builds a `dynamicSystemContext` string combining the visitor profile and framing.** This string is passed to `AnthropicService.sendMessage` as the fourth parameter, which appends it as a second text block in the `system` array — without a `cache_control` marker so it does not interfere with caching on the static base prompt block.

If `budgetContext` is also set, the two contexts are concatenated:
```typescript
dynamicSystemContext = budgetContext
  ? `${budgetContext}\n\n${continuationContextBlock}`
  : continuationContextBlock;
```

Where `continuationContextBlock` is the visitor profile + framing template (see exact text below). This keeps the `dynamicSystemContext` as a single string, matching `AnthropicService.sendMessage`'s existing `string` parameter type — no changes to `AnthropicService` are needed.

**The messages array contains ONLY real visitor/agent turns.** The loader prepends prior session messages to `messages` but adds no synthetic role:user metadata injections. Profile and framing go through `dynamicSystemContext`, not through a fake user-role message.

### Dynamic context block — exact text template

```typescript
const PRIOR_HISTORY_MESSAGE_LIMIT = 20;

function buildContinuationContextBlock(profile: {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
}): string {
  const phone = profile.phone ?? "not provided";
  return [
    "The visitor you're talking to is a returning customer:",
    `- Name: ${profile.firstName} ${profile.lastName}`,
    `- Email: ${profile.email}`,
    `- Phone: ${phone}`,
    "",
    "They were just verified. The conversation messages below begin with their prior session, then continue with today's session. Briefly acknowledge what you were working on together before answering their current question.",
  ].join("\n");
}
```

### Prior-session DDB Query

**CHAT_TURN schema confirmed:** actual DDB records use `SK begins_with "MESSAGE#"` — the constant `MESSAGE_SK_PREFIX = "MESSAGE#"` and `ChatSessionMessageRecord` type are confirmed in `chat-session.service.ts`. The prior-session query uses this exact same pattern:

```typescript
const priorSessionPk = `${CHAT_SESSION_PK_PREFIX}${continuationFromSessionId}`;

const priorHistoryResult = await this.dynamoDb.send(
  new QueryCommand({
    TableName: table,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
    ExpressionAttributeValues: {
      ":pk": priorSessionPk,
      ":skPrefix": MESSAGE_SK_PREFIX,
    },
    ScanIndexForward: false,
    Limit: PRIOR_HISTORY_MESSAGE_LIMIT,  // 20
  }),
);
```

`ScanIndexForward: false` returns the 20 most-recent messages in descending order. Reverse in memory (same pattern as current-session history at line 181) to get chronological order for injection.

### Customer profile read

```typescript
// customerId is already set from metadataResult.Item?.customer_id (line 82)
// It is guaranteed non-null here because continuation_from_session_id is non-null —
// verify_code only sets continuation_from_session_id when customer_id is also set.
const customerKey = customerId!.startsWith("C#") ? customerId! : `C#${customerId!}`;

const customerResult = await this.dynamoDb.send(
  new GetCommand({
    TableName: table,
    Key: { PK: customerKey, SK: customerKey },
  }),
);

const customerProfile = customerResult.Item;
```

Fields read: `first_name`, `last_name`, `email`, `phone`.

### Message array splice order

After loading, `messages` becomes:

```
[
  ...priorSessionMessages (chronological order, oldest first),
  ...currentSessionHistory (history from handleMessage query),
  newUserMessage (the current user turn),
]
```

No profile message or framing message appears in the messages array — those are in `dynamicSystemContext` only.

```typescript
// priorMessagesChronological = [...priorHistoryResult.Items].reverse()
messages.unshift(...priorMessagesChronological);
```

Final array layout:
```
[prior_turn_1, prior_turn_2, ..., prior_turn_N,   ← prior session (chronological)
 currentHistory_turn_1, ..., currentHistory_turn_M, ← current session history
 newUserMessage]                                     ← current user turn
```

### `continuation_loaded_at` write

A separate UpdateCommand, issued best-effort immediately after the splice and before the tool loop, using `if_not_exists` to handle races between parallel turns:

```typescript
const loaderTimestamp = new Date().toISOString();

try {
  await this.dynamoDb.send(
    new UpdateCommand({
      TableName: table,
      Key: { PK: sessionPk, SK: METADATA_SK },
      UpdateExpression:
        "SET continuation_loaded_at = if_not_exists(continuation_loaded_at, :now), #lastUpdated = :now",
      ExpressionAttributeNames: { "#lastUpdated": "_lastUpdated_" },
      ExpressionAttributeValues: { ":now": loaderTimestamp },
    }),
  );
} catch (flagError: unknown) {
  const errorName = flagError instanceof Error ? flagError.name : "UnknownError";
  this.logger.warn(
    `[event=continuation_flag_write_failed errorType=${errorName} sessionUlid=${sessionUlid}]`,
  );
  // Non-fatal: loader has already spliced messages and set dynamicSystemContext.
  // Worst case the loader fires again on the next turn — idempotent in effect.
}
```

Note: `loaderTimestamp` is captured fresh inside the loader block. The `now` variable declared at line 272 is post-tool-loop and is not in scope here.

### Loader failure handling

If either DDB read (Customer GetCommand or prior-session QueryCommand) throws: log `[event=continuation_load_failed errorType=... sessionUlid=...]`, skip the loader entirely. `messages` is unmodified, `dynamicSystemContext` stays at `budgetContext`. `continuation_loaded_at` is NOT set — the loader will retry on the next turn.

If the Customer record is missing (`customerResult.Item` is undefined): log `[event=continuation_loader_customer_not_found sessionUlid=...]`, skip. Non-fatal.

If the prior-session QueryCommand returns zero items: the loader still fires, `dynamicSystemContext` gets the profile + framing block, no prior turns prepended. `continuation_loaded_at` is set. The agent sees the profile context but no prior conversation history — correct behaviour.

### Loader structure: parallel reads

The two DDB reads (Customer GetCommand and prior-session QueryCommand) are independent and are issued in parallel via `Promise.all`. If the style guide prefers sequential reads, switching does not affect correctness.

---

## Framing and Profile: Exact Named Constants

```typescript
// In chat-session.service.ts — module-level constants:
const PRIOR_HISTORY_MESSAGE_LIMIT = 20;
```

The profile + framing block is assembled via `buildContinuationContextBlock` (a pure function, defined at module level or inline in the loader block). The exact output text uses the template shown above.

---

## System Prompt RETURNING VISITOR FLOW Section

The literal text below must be appended verbatim to the `systemPrompt` of both `lead_capture.agent.ts` and `shopping_assistant.agent.ts`. The implementer copies it word-for-word.

---

```
RETURNING VISITOR FLOW:

When collect_contact_info returns { saved: true, customerFound: true } in the response:
- The visitor's email matches a returning customer on file.
- Welcome them back by first name warmly and briefly: for example, "Welcome back, [name]! Let me send a quick verification code to confirm it's you."
- Immediately call request_verification_code() — do not wait for the visitor to ask.
- Do NOT proceed with the normal conversation flow until verification is complete.

When the visitor pastes or types a code after receiving it:
- Extract the 6 digits from whatever the visitor wrote. They may say "here it is: 1 2 3 4 5 6" or "123456" or "here's the code: 042007" — extract only the 6-digit numeric sequence.
- Call verify_code(code) immediately with the extracted digits.
- If the submitted value is clearly not 6 digits (e.g., 5 digits, letters, blank), ask the visitor to double-check and re-send.

On verify_code returning { verified: true }:
- Acknowledge the visitor briefly and warmly.
- The prior conversation has been loaded into your context. Review it and reference ONE specific thing from it naturally, as if continuing a conversation: for example, "Last time we were looking into the dog-walking package — want to pick up there?" or "I see we were discussing the deluxe grooming option last time."
- Do NOT recite the entire prior conversation. One specific, natural reference is enough.
- Then answer the visitor's current question directly.

On verify_code returning { verified: false, reason: "wrong_code" }:
- Ask the visitor to double-check the code and try again.
- Call verify_code again with the new attempt.

On verify_code returning { verified: false, reason: "expired" }:
- Apologize briefly and call request_verification_code() again to send a fresh code.
- Inform the visitor that a new code is on its way to their email.

On verify_code returning { verified: false, reason: "max_attempts" }:
- Call request_verification_code() once to send a fresh code.
- Ask the visitor to try once more with the new code.

On verify_code returning { verified: false, reason: "no_pending_code" }:
- This is unusual — the code may have expired or already been used.
- Call request_verification_code() and let the visitor know a new code is on its way.

On repeated failure — when the visitor has exhausted attempts on a fresh code, OR has ignored or bypassed verification for more than two conversational turns:
- Gracefully give up. Say something natural and warm, for example: "No worries — let's keep going from here."
- Do NOT mention prior history. Do NOT attempt verification again. Do NOT re-call request_verification_code.
- Treat the visitor as a new visitor for the rest of the session and continue the normal conversation flow.

Privacy guard:
- Never echo the verification code back to the visitor.
- Never tell the visitor what code is on file or what the correct code is.
- The code lives only in the visitor's email. You do not know it.
```

---

## Step-by-Step Implementation Sequence

```
1. [src/types/ChatSession.ts] Add the two new fields to ChatSessionMetadataRecord
   - Add continuation_from_session_id: string | null immediately after customer_id
   - Add continuation_loaded_at: string | null immediately after continuation_from_session_id
   - Both are non-optional (matching customer_id's convention)
   - Why first: all downstream satisfies checks and identity.service.ts init depend on the type
   - Done when: TypeScript compiles; the two new fields appear in ChatSessionMetadataRecord

2. [src/services/identity.service.ts] Initialise both new fields as null at session creation
   - Add to setClauses:
       "continuation_from_session_id = if_not_exists(continuation_from_session_id, :contFromNull)"
       "continuation_loaded_at = if_not_exists(continuation_loaded_at, :contAtNull)"
   - Add to expressionValues: ":contFromNull": null, ":contAtNull": null
   - Add both fields to the metadataItem satisfies object: continuation_from_session_id: null, continuation_loaded_at: null
   - Why second: establishes the baseline null state every new session starts with
   - Done when: TypeScript compiles; metadataItem satisfies ChatSessionMetadataRecord passes

3. [src/services/customer.service.ts] Extend queryCustomerIdByEmail return type
   - Change return type to Promise<{ customerUlid: string; latestSessionId: string | null } | null>
   - In the success branch, read items[0].latest_session_id and coerce to string | null
   - Return { customerUlid: pk.slice(CUSTOMER_PK_PREFIX.length), latestSessionId }
   - Update lookupOrCreateCustomer Step A: derive existingUlid = lookupResult ? lookupResult.customerUlid : null
   - Update Step D (race recovery) identically
   - Why third: both tool callers (verify_code, collect_contact_info) depend on this shape
   - Done when: TypeScript compiles; lookupOrCreateCustomer still returns GuestCartLookupOrCreateResult unchanged

4. [src/services/customer.service.spec.ts] Update tests for new return shape
   - Update all queryCustomerIdByEmail test assertions to expect { customerUlid, latestSessionId } shape
   - Add 4 new cases: non-null latestSessionId; no attribute; null attribute; lookupOrCreateCustomer still works
   - Why here: validates the refactored CustomerService before tool callers are changed
   - Done when: all 4 new cases pass; existing queryCustomerIdByEmail cases pass with updated assertions

5. [src/tools/collect-contact-info.tool.ts] Confirm no direct queryCustomerIdByEmail call
   - Verify this tool calls lookupOrCreateCustomer only; if so, no change needed here
   - Confirm the tool compiles cleanly after step 3
   - Why here: verify no accidental breakage before touching verify_code
   - Done when: TypeScript compiles; npm test passes collect-contact-info.tool.spec.ts

6. [src/tools/collect-contact-info.tool.spec.ts] Confirm or update mocks
   - Verify that the spec mocks CustomerService.lookupOrCreateCustomer directly (not queryCustomerIdByEmail)
   - If any direct queryCustomerIdByEmail mock exists: update it to the new return shape
   - Done when: all existing collect-contact-info.tool.spec.ts cases pass unchanged

7. [src/tools/verify-code.tool.ts] Extend Write A to capture continuation_from_session_id
   - Destructure both fields from the extended queryCustomerIdByEmail result:
       const lookupResult = await this.customerService.queryCustomerIdByEmail(...);
       if (lookupResult === null) { ... }
       customerUlid = lookupResult.customerUlid;
       const latestSessionId = lookupResult.latestSessionId;
   - Update Write A UpdateExpression to include continuation_from_session_id = :contFromSessionId
   - Add ":contFromSessionId": latestSessionId to ExpressionAttributeValues
   - Write B and Write C are UNCHANGED
   - Why seventh: step 3 must be in place (new return type) before this call site change
   - Done when: TypeScript compiles; verify-code.tool.spec.ts passes updated tests

8. [src/tools/verify-code.tool.spec.ts] Update tests for the new Write A field and mock returns
   - Update mockCustomerService.queryCustomerIdByEmail mock to return the new shape
   - Update happy-path test: assert Write A UpdateExpression includes continuation_from_session_id;
     assert ":contFromSessionId" value matches the mock's latestSessionId
   - Add new case: latestSessionId is null → Write A sets continuation_from_session_id to null
   - Add new case: verify_code failure path → no continuation_from_session_id write occurs
   - Why eighth: validates the new Write A shape
   - Done when: all verify-code tests pass; new cases pass; build is clean

9. [src/services/chat-session.service.ts] Wire the prior-history loader
   - Add module-level constant: PRIOR_HISTORY_MESSAGE_LIMIT = 20
   - Add module-level helper: buildContinuationContextBlock(profile) — pure function returning
     the visitor profile + framing text (exact template from this plan)
   - Lift dynamicSystemContext out of the while loop: declare as `let dynamicSystemContext: string | undefined`
     before the loader block, initialised from budgetCents (same logic as today but outside the loop)
   - After `const newMessages = [newUserMessage]` (line 200) and BEFORE `let iteration = 0`:
     insert the loader block:
       a. Read continuation_from_session_id and continuation_loaded_at from metadataResult.Item
       b. Check gate: both conditions must hold
       c. If gate passes:
          - Issue Promise.all: GetCommand(Customer) + QueryCommand(prior session, Limit 20, ScanIndexForward false)
          - Reverse prior items to chronological order
          - Map prior items to ChatSessionNewMessage[] (same parse logic as history at line 183)
          - messages.unshift(...priorMessagesChronological)
          - Build continuationContextBlock via buildContinuationContextBlock(profile fields)
          - Set dynamicSystemContext = budgetContext ? `${budgetContext}\n\n${continuationContextBlock}` : continuationContextBlock
          - Issue continuation_loaded_at UpdateCommand with if_not_exists (best-effort try/catch)
          - Log [event=continuation_loaded sessionUlid=... priorCount=...]
          - If loader's Promise.all throws: log [event=continuation_load_failed ...], skip; dynamicSystemContext stays at budgetContext
   - Inside the while loop: replace the current dynamicSystemContext build block (lines 211–214)
     with just the pre-computed variable (it is now set before the loop)
   - Why ninth: all foundational changes must be in place first
   - Done when: TypeScript compiles; build is clean

10. [src/services/chat-session.service.spec.ts] Add loader tests
    - Update the existing METADATA GetCommand mock in beforeEach to include
      continuation_from_session_id: null, continuation_loaded_at: null
    - Add 13 new cases (see Testing Strategy section)
    - Why tenth: validates the loader before agent prompt changes
    - Done when: all 13 new cases pass; all existing cases pass

11. [src/agents/lead-capture.agent.ts] Append RETURNING VISITOR FLOW section
    - Append the exact text from the "System Prompt RETURNING VISITOR FLOW Section" block above
      to the end of the systemPrompt template literal, preceded by a blank line
    - Do NOT modify allowedToolNames — "request_verification_code" and "verify_code" are already present
    - Done when: TypeScript compiles; the new section appears verbatim in the prompt

12. [src/agents/shopping-assistant.agent.ts] Append RETURNING VISITOR FLOW section
    - Identical change: append the same exact RETURNING VISITOR FLOW text to systemPrompt
    - Do NOT modify allowedToolNames — both verification tools are already present
    - Done when: TypeScript compiles; the new section appears verbatim in the prompt

13. [Agent spec files] Smoke-test new prompt section
    - Add to each agent's spec (or create if none exists):
        - Assert that the systemPrompt string includes "RETURNING VISITOR FLOW"
        - Assert that allowedToolNames includes "request_verification_code" and "verify_code"
    - Done when: tests pass
```

---

## Testing Strategy

### `src/services/customer.service.spec.ts` — UPDATE existing + ADD 4 cases

**Existing `queryCustomerIdByEmail` tests — update assertions:**

All assertions checking `.toBe(CUSTOMER_ULID)` or `.toBeNull()` must be updated:
- Returning a Customer item: expect `{ customerUlid: CUSTOMER_ULID, latestSessionId: null }` (when item has no `latest_session_id`)
- Returning null (no items): expect `null` (unchanged)
- Returning null (bad PK): expect `null` (unchanged)

**New cases under `describe("queryCustomerIdByEmail — latestSessionId")`:**

| # | Description | Setup | Assertion |
|---|-------------|-------|-----------|
| 1 | Returns non-null latestSessionId when Customer record has the field | QueryCommand returns item with `latest_session_id: "01PRIORSESSION00000000000"` | Returns `{ customerUlid: CUSTOMER_ULID, latestSessionId: "01PRIORSESSION00000000000" }` |
| 2 | Returns null latestSessionId when item has no latest_session_id | QueryCommand returns item without `latest_session_id` attribute | Returns `{ customerUlid: CUSTOMER_ULID, latestSessionId: null }` |
| 3 | Returns null latestSessionId when latest_session_id is null | QueryCommand returns item with `latest_session_id: null` | Returns `{ customerUlid: CUSTOMER_ULID, latestSessionId: null }` |
| 4 | lookupOrCreateCustomer still resolves correct customerUlid after refactor | QueryCommand (lookup) returns item with `latest_session_id: "01PRIORSESSION"` | Returns `{ isError: false, customerUlid: CUSTOMER_ULID, created: false }`; no PutCommand called |

### `src/tools/verify-code.tool.spec.ts` — UPDATE existing + ADD 3 cases

**Update mock for all existing tests:** Change `mockCustomerService.queryCustomerIdByEmail.mockResolvedValue(CUSTOMER_ULID)` to `mockCustomerService.queryCustomerIdByEmail.mockResolvedValue({ customerUlid: CUSTOMER_ULID, latestSessionId: "01PRIORSESSIONULID000000000" })` (or null as appropriate).

**Update happy-path test (Test 1):**
- Assert Write A UpdateCommand includes `continuation_from_session_id` in UpdateExpression
- Assert `:contFromSessionId` ExpressionAttributeValues equals `"01PRIORSESSIONULID000000000"`

**New cases:**

| # | Description | Setup | Assertion |
|---|-------------|-------|-----------|
| 1 | Write A sets continuation_from_session_id to null when customer has no prior session | `mockResolvedValue({ customerUlid: CUSTOMER_ULID, latestSessionId: null })` | Write A UpdateCommand called with `:contFromSessionId = null`; still returns `{ verified: true, customerId }` |
| 2 | Write A sets continuation_from_session_id to the prior session ULID (happy path explicit check) | `latestSessionId: "01PRIORSESSIONULID000000000"` | Write A `:contFromSessionId === "01PRIORSESSIONULID000000000"` |
| 3 | verify_code failure path: continuation_from_session_id is NOT written when code is wrong | Wrong code submitted | No UpdateCommand with continuation_from_session_id in UpdateExpression; returns `{ verified: false, reason: "wrong_code" }` |

### `src/services/identity.service.spec.ts` (existing) — ADD 2 cases

| # | Description | Assertion |
|---|-------------|-----------|
| 1 | New session METADATA write includes continuation_from_session_id: null | Capture UpdateCommand args; assert `:contFromNull` is `null`; UpdateExpression includes `continuation_from_session_id = if_not_exists(...)` |
| 2 | New session METADATA write includes continuation_loaded_at: null | Assert `:contAtNull` is `null`; UpdateExpression includes `continuation_loaded_at = if_not_exists(...)` |

### `src/services/chat-session.service.spec.ts` — ADD 13 cases

Build context: the existing METADATA GetCommand mock in `beforeEach` returns `{ agent_name: "lead_capture", account_id: "01ACCOUNTULID00000000000000" }`. Tests that exercise the loader path must override the GetCommand mock to return a METADATA item with `continuation_from_session_id` and `continuation_loaded_at`.

| # | Description | Setup | Assertion |
|---|-------------|-------|-----------|
| 1 | Loader does NOT fire when continuation_from_session_id is null | METADATA returns `continuation_from_session_id: null` | QueryCommand called exactly once (current-session history); GetCommand called exactly once (METADATA) |
| 2 | Loader does NOT fire when continuation_loaded_at is non-null (already loaded) | METADATA returns `continuation_from_session_id: "01PRIORSESSION"`, `continuation_loaded_at: "2026-01-01T00:00:00.000Z"` | QueryCommand called exactly once; no second QueryCommand; no Customer GetCommand |
| 3 | Loader fires when both gate conditions hold | METADATA returns `continuation_from_session_id: "01PRIORSESSION"`, `continuation_loaded_at: null`, `customer_id: "C#01CUSTOMERULID"` | QueryCommand called twice (current-session + prior-session); GetCommand called twice (METADATA + Customer) |
| 4 | Prior messages are prepended in chronological order | METADATA gate passes; prior QueryCommand returns items in descending SK order | sendMessage called with messages where first N are prior turns (oldest first), then current history turns |
| 5 | Messages array contains NO synthetic profile or framing role:user entries | METADATA gate passes | No message in the array sent to sendMessage has content matching the profile template or framing text |
| 6 | Visitor profile and framing appear in dynamicSystemContext, not in messages | METADATA gate passes; Customer GetCommand returns `{ first_name: "Jane", last_name: "Doe", email: "j@x.com", phone: "555-0100" }` | sendMessage called with dynamicSystemContext containing "Name: Jane Doe", "Email: j@x.com", "Phone: 555-0100", and the framing sentence |
| 7 | Profile uses "not provided" for null phone | Customer item has no phone field | dynamicSystemContext contains "Phone: not provided" |
| 8 | continuation_loaded_at UpdateCommand uses if_not_exists | METADATA gate passes | UpdateCommand on METADATA has `if_not_exists(continuation_loaded_at` in UpdateExpression |
| 9 | continuation_loaded_at UpdateCommand fires after loader completes, before tool loop | METADATA gate passes | UpdateCommand sequence: continuation_loaded_at write appears before sendMessage call |
| 10 | Loader failure is non-fatal (Customer GetCommand throws) | METADATA gate passes; Customer GetCommand rejects | handleMessage resolves normally; sendMessage called with dynamicSystemContext = budgetContext only; continuation_loaded_at UpdateCommand NOT called; no prior turns in messages |
| 11 | Loader with empty prior session (zero messages) | METADATA gate passes; prior QueryCommand returns [] | sendMessage called with no prior-session messages prepended; dynamicSystemContext contains profile + framing; continuation_loaded_at UpdateCommand called |
| 12 | Loader injects exactly 20 messages when prior session has 25 | METADATA gate passes; prior QueryCommand returns 20 items (Limit applied by DDB) | sendMessage called with exactly 20 prior-session messages + current history |
| 13 | No-op for unverified sessions: messages array and dynamicSystemContext unchanged | Default METADATA mock (null continuation_from_session_id) | sendMessage messages matches [history..., newUserMessage]; dynamicSystemContext matches budget-only string (or undefined) |

### Agent spec files (lead-capture, shopping-assistant) — ADD 2 cases each

| # | Description | Assertion |
|---|-------------|-----------|
| 1 | RETURNING VISITOR FLOW section present in systemPrompt | `expect(agent.systemPrompt).toContain("RETURNING VISITOR FLOW")` |
| 2 | Verification tools in allowedToolNames | `expect(agent.allowedToolNames).toContain("request_verification_code")` and `expect(agent.allowedToolNames).toContain("verify_code")` |

**Estimated new test count:** 4 (CustomerService) + 3 (verify_code) + 2 (identity.service) + 13 (chat-session.service) + 4 (agent smoke tests) = **26 new tests**. Total phase budget: 25–35 tests. Within budget.

---

## Risks and Edge Cases

**High — Write A must fire BEFORE Write B in verify_code.**

The order of capture is critical: `queryCustomerIdByEmail` returns `latestSessionId` which is the CURRENT value on the Customer record. If Write B fires first, it overwrites `customer.latest_session_id` with the current session's ULID — permanently losing the prior session pointer. The existing code already sequences these writes in order (Write A → Write B → Write C). The new `latestSessionId` capture happens at the query site, which is before ALL writes. Sequence is preserved by construction. Reviewer must verify the UpdateExpression for Write A includes `continuation_from_session_id` and that no reordering occurs.

**High — `continuation_from_session_id` is a bare ULID (no `CHAT_SESSION#` prefix).**

The prior-session QueryCommand uses `CHAT_SESSION_PK_PREFIX + continuationFromSessionId`. The value stored in the field MUST be a bare ULID. This mirrors how `latest_session_id` is stored on the Customer record (also bare, per CCI-1 convention). The `queryCustomerIdByEmail` return value for `latestSessionId` comes directly from the Customer record's `latest_session_id` attribute — which CCI-1 confirms is stored as a bare ULID. No prefix manipulation needed.

**High — `CustomerService.queryCustomerIdByEmail` return type change is a breaking refactor.**

Every call site must be updated. There are exactly three call sites:
1. `verify-code.tool.ts` (external caller — updated in step 7)
2. `lookupOrCreateCustomer` Step A in `customer.service.ts` (internal caller — updated in step 3)
3. `lookupOrCreateCustomer` Step D (race recovery) in `customer.service.ts` (internal caller — updated in step 3)

If any call site is missed, TypeScript will error at compile time — the type system is the safety net.

**High — `dynamicSystemContext` must be lifted out of the while loop.**

Currently `dynamicSystemContext` is declared inside the `while` loop (lines 211–214 of `chat-session.service.ts`), recomputed each iteration. The loader runs before the loop and must be able to set this value. If it stays inside the loop, the loader's extension would be overwritten on the first iteration. The implementer must move the declaration before the loader block and before `let iteration = 0`. The loop then reads the pre-computed value unchanged on every iteration.

**Medium — cache_control on the static base prompt must be preserved.**

The `AnthropicService.sendMessage` method correctly places `cache_control: { type: "ephemeral" }` on the static base prompt block and omits it from the dynamic block. The loader does NOT pass `cache_control` anywhere — it only provides a string to `dynamicSystemContext`. This is correct by construction: the cache_control placement lives entirely in `anthropic.service.ts` and is unaffected by the loader. Reviewer should confirm `anthropic.service.ts` is unchanged and that the cache_control marker is still on the static block.

**Medium — Parallel turns racing for the loader's `continuation_loaded_at` flag.**

Two simultaneous turns could both read `continuation_loaded_at: null` and both attempt to run the loader. Both will extend `dynamicSystemContext` with the same profile + framing and prepend prior messages to their local `messages` array (no shared state). Both will call Anthropic with equivalent context. Both will issue the `continuation_loaded_at` UpdateCommand — but the `if_not_exists` expression ensures only the first writer's timestamp is persisted. The race has no data-correctness consequence. Document this in a code comment.

**Medium — Prior session has 0 messages (visitor had a session but never exchanged messages).**

The QueryCommand returns an empty array. The loader still fires, sets `dynamicSystemContext` with profile + framing, prepends nothing to messages, and sets `continuation_loaded_at`. The agent sees only profile and framing context in the system prompt and no prior turns. The framing sentence references "the conversation messages below" but there are none — the agent will produce a generic warm welcome. Acceptable per design.

**Medium — Prior session messages preserve their original `role` values.**

When mapping prior DDB items to `ChatSessionNewMessage[]`, the role is read directly from the persisted `role` field (`"user"` or `"assistant"`). The loader does NOT flip or re-tag roles. Reviewer must confirm the mapping uses the stored role value unchanged.

**Low — `dynamicSystemContext` concatenation with budget context.**

When both `budgetContext` and `continuationContextBlock` are set, they are joined with `\n\n`. The order should be: budget context first, then continuation block — consistent with the current solo-budget behaviour. Ensure the concatenation does not produce double newlines or leading/trailing whitespace that could interfere with prompt caching on the static block (the dynamic block is uncached, so this is cosmetic only).

**Low — Customer record is missing at loader time (deleted between verify_code and the next turn).**

Extremely unlikely in production. The loader handles this by catching the missing Item case and treating it as a loader failure — log a warning, skip the loader, do not set `continuation_loaded_at`. Loader retries on the next turn. Graceful degradation.

**Low — Token budget with long prior sessions.**

The loader injects at most 20 prior messages. Typical messages in this codebase are short tool-use exchanges (50–200 tokens each). 20 messages ≈ 1,000–4,000 tokens. Plus profile + framing in dynamicSystemContext (~100 tokens). Total overhead: ~1,100–4,100 tokens. Well within Claude's 200k context window. No truncation logic needed.

---

## Out-of-Scope Confirmations

The following are explicitly NOT part of Phase CCI-2b:

- SendGrid Inbound Parse webhook changes (Case 2/3 dispatch) — Phase 3
- Email-inbound continuation flow — Phase 3
- Per-merchant branded verification email templates — Phase 4
- Tool-level validation that errors when downstream tools fire without contact-complete data — Phase 4
- USER_FACT loading from prior sessions into context — explicitly deferred (brief §Out of scope)
- USER_CONTACT_INFO loading from prior sessions — current session has its own copy
- Per-session conversation summarization for long-term memory — deferred to v2
- Phone-keyed identity (no phone GSI) — future work
- Cart-handoff URL flow changes — preserved exactly as today
- Any changes to `/chat/web/*`, iframe auth model, kickoff/onboarding state machines
- Refactor of existing TS variable names — naming convention applies forward only
- New Slack alerts — returning-visitor verification is not a celebration event; locked rule from Phase 8b-followup applies absolutely
- PII in logs — no email, customer name, or verification code in any log line
- Changes to `src/services/anthropic.service.ts` — the existing `dynamicSystemContext` parameter is the exact hook needed; no changes required

---

## Needs Orchestrator Decision

**None.** All decisions are resolved:

- Exact wiring point: after `const newMessages = [newUserMessage]` (line 200), before `let iteration = 0` (line 202) — with `dynamicSystemContext` lifted out of the while loop.
- Profile + framing injection format: via `dynamicSystemContext` string parameter to `AnthropicService.sendMessage` (Option B). No role:user injections into the messages array. `AnthropicService` already builds the two-block system array with `cache_control` on the static block — no changes to that service needed.
- CustomerService return-type change: confirmed; three call sites identified and all updated; TypeScript enforces completeness.
- `continuation_loaded_at` write: separate UpdateCommand with `if_not_exists`, issued best-effort inside the loader block before the tool loop.
- Dynamic context block exact text: locked template in `buildContinuationContextBlock` per this plan.
- CHAT_TURN schema: actual records use `MESSAGE#` SK prefix; prior-session Query uses `begins_with(SK, "MESSAGE#")` with `Limit: 20` and `ScanIndexForward: false`, then reversed in memory.
- Messages array: only real visitor/agent turns. No synthetic metadata injections.
