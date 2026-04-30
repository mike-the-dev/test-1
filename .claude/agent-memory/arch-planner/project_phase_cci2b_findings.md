---
name: Phase CCI-2b chat-side agent flow — codebase findings
description: Key schema and code discoveries from planning Phase CCI-2b; prior-session loader wiring, MESSAGE# SK prefix, user-role-only message array, Promise.all for loader reads
type: project
---

Session messages in DDB use SK prefix `MESSAGE#` (not `CHAT_TURN#` — the design doc uses the conceptual term "CHAT_TURN" but the actual constant is `MESSAGE_SK_PREFIX = "MESSAGE#"` in chat-session.service.ts).

The `messages` array passed to Anthropic contains only `role: "user" | "assistant"` entries — `ChatSessionNewMessage` type. System-role messages cannot be injected here. The Anthropic system prompt is passed separately as `agent.systemPrompt` in `anthropicService.sendMessage`. This means context injection (prior turns, profile, framing) must use `role: "user"` messages.

`handleMessage` wiring point for prior-history loader: after `const messages = [...history, newUserMessage]` (line ~200 in current file) and before the `while (iteration < MAX_TOOL_LOOP_ITERATIONS)` loop. The `metadataResult.Item` (fetched at line ~71) already contains the new `continuation_from_session_id` and `continuation_loaded_at` fields — no second METADATA read needed.

`continuation_loaded_at` requires a SEPARATE UpdateCommand (not folded into the existing METADATA UpdateCommand) because the loader only reads (GetCommand + QueryCommand) — it has no other DDB write to fold into.

`CustomerService.queryCustomerIdByEmail` has exactly 3 call sites: (1) `verify-code.tool.ts` (external), (2) `lookupOrCreateCustomer` Step A in `customer.service.ts` (internal), (3) `lookupOrCreateCustomer` Step D race recovery in `customer.service.ts` (internal). `preview-cart.tool.ts` no longer calls it after Phase 2a.

`newMessages` vs `messages` distinction in handleMessage: `messages` is the full Claude input array (includes prior-session injection, current history, new turn); `newMessages` starts as `[newUserMessage]` and accumulates new messages from the tool loop. Only `newMessages` is persisted to DDB. Prior-session injected messages are ephemeral (in `messages` only, never written to DDB).

**Why:** This is the shape of the code as shipped after CCI-1 and CCI-2a. These findings avoid re-reading the same files in future sub-phases.

**How to apply:** When planning any future change to chat-session.service.ts message handling, remember the `messages` vs `newMessages` split and the user-role-only constraint on the message array.
