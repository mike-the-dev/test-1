TASK OVERVIEW
Task name: Email reply debounce with cross-channel coherence (90s window)

Objective:
Stop the email channel from producing janky, out-of-order replies when a user sends multiple emails in rapid succession. Today every inbound email synchronously triggers `chatSessionService.handleMessage` (full LLM round-trip) and one outbound email — so 3 emails in 30 seconds means 3 concurrent `handleMessage` calls racing on session history writes, 3 LLM round-trips ignorant of each other, and 3 outbound replies arriving in semi-random order, each answering only a fragment of what the user actually meant.

After this task: inbound emails are written to conversation history immediately (preserving order, no data loss), but the LLM-and-reply step is deferred via a 90-second EventBridge Scheduler debounce window. New inbound emails within the window reset the timer. When the timer fires, ONE consolidated reply gets generated covering all outstanding user messages. If the user switches to another channel (web or SMS) during the window, that channel's reply path consumes ALL pending user messages (across channels) into one reply AND cancels the pending email schedule — no stale email reply ever lands. Cross-channel coherence is airtight because every reply path on every channel routes through a single chokepoint that owns the cancellation contract.

Relevant context:
- This is the last major piece of work before shipping. It must be airtight, scalable to a million users, and consistent with the existing codebase conventions. Scalability is the north star.
- Affected services: `src/services/email-reply.service.ts`, `src/services/sms-reply.service.ts`, `src/services/chat-session.service.ts`, `src/controllers/web-chat.controller.ts`
- New services to create: `SchedulerService` (wraps `@aws-sdk/client-scheduler`), `ReplyOrchestratorService` (the cross-channel chokepoint)
- New controller: `InternalEmailFlushController` for the auth'd EventBridge callback endpoint
- New guard: `InternalAuthGuard` for bearer-token validation on the flush endpoint
- New types in `src/types/`: `Scheduler.ts`, `ReplyOrchestrator.ts`, possibly `EmailFlush.ts`
- DDB schema: NO new tables, NO new attributes on existing records (conversation history rows already exist; this task just adds rows with `channel: "email"` attribution if not already present). The arch-planner must audit whether `channel` attribution exists on the current message-row schema and propose adding it if missing.
- EventBridge Scheduler: pay-per-invocation, ~pennies at our volume. Real infrastructure setup required (IAM role for app, IAM role for scheduler, API Destination + Connection in EventBridge). About half a day of ops work outside the code repo.
- No production data exists for the email-debounce path — clean cut, no migration.
- The frontend embed is NOT affected by this task. The web reply path stays synchronous from the user's perspective; the change is internal (web reply now routes through the orchestrator, which also cancels pending email schedules).
- The `assistant@reply.<domain>` inbound flow (currently exercised in production for `reply.instapaytient.com`) is the primary use case. Per-account multi-tenant routing already shipped; this layers on top.

Architectural design (LOCKED IN CONVERSATION — DO NOT REVISIT):

LAYER 1 — Inbound writes are synchronous and channel-agnostic
- Every inbound user message (web, SMS, email) gets written to conversation history IMMEDIATELY, regardless of channel.
- Each message row carries `channel: "web" | "sms" | "email"` attribution.
- History is the source of truth for conversation state. The schedule is just a wake-up mechanism — it does NOT carry message content.

LAYER 2 — Reply generation is per-channel-timed but channel-aware
- Reply timing decisions:
  - **Web** → immediate
  - **SMS** → immediate (consumer expectation)
  - **Email** → 90-second debounce; reset window on each new inbound email
- Every reply generation, regardless of channel, routes through `ReplyOrchestratorService.generateAndSendReply(sessionUlid, channel)`. This is the chokepoint.

LAYER 3 — The orchestrator owns cross-channel coherence
- `ReplyOrchestratorService.generateAndSendReply(sessionUlid, channel)` does:
  1. Read history; find user messages after the last assistant reply.
  2. If empty → no-op + log + return (the schedule fired against stale state, or another channel already replied).
  3. Build LLM input from all outstanding user messages.
  4. Call LLM, get reply.
  5. Write assistant reply to history.
  6. Send outbound via the channel specified (`email`, `sms`, `web`).
  7. **Cancel any pending email schedule for this session** (cross-channel hook — fires for every channel, including email itself when its own schedule was the trigger).

LAYER 4 — Email inbound webhook deferral
- `EmailReplyService.processInboundReply` change: instead of calling `chatSessionService.handleMessage` synchronously, it now:
  1. Keep all existing guards (Message-ID dedupe, sender match, domain routing, account lookup, etc.) — UNCHANGED.
  2. After classification succeeds, write the user message to conversation history via `chatSessionService.appendUserMessage(sessionUlid, channel: "email", text, ...)`. NO LLM call here.
  3. Call `SchedulerService.createOrResetEmailFlush(sessionUlid, fireAtMs = Date.now() + 90_000)`. This idempotently deletes any existing `email-flush-<sessionUlid>` schedule and creates a new one targeting `POST /internal/email-flush/:sessionUlid` 90 seconds from now.
  4. Return 200 to SendGrid immediately.

LAYER 5 — Internal flush endpoint
- New endpoint `POST /internal/email-flush/:sessionUlid`, auth'd by `InternalAuthGuard` (bearer token in `X-Internal-Auth` header matching `INTERNAL_FLUSH_SECRET` env var).
- Body: `{ sessionUlid: string }` (matches the path param; redundant for safety).
- Behavior: call `ReplyOrchestratorService.generateAndSendReply(sessionUlid, channel: "email")`. The orchestrator handles read-history, LLM, write-reply, send-email, and self-cancel-schedule. The flush endpoint is a thin dispatcher.

LAYER 6 — Cross-channel cancellation in practice
- Web chat reply (`/chat/web/sessions/:sessionId/messages` POST) → routes through `ReplyOrchestratorService.generateAndSendReply(sessionUlid, "web")` → orchestrator cancels pending email schedule as part of step 7.
- SMS inbound reply (`/webhooks/twilio/inbound`) → routes through orchestrator with `channel: "sms"` → same cancellation.
- Email flush callback → routes through orchestrator with `channel: "email"` → same cancellation (no-op since it's a one-shot schedule that's about to auto-delete anyway, but the call is consistent).

LAYER 7 — Split `chat-session.service.ts.handleMessage`
- Current `handleMessage(sessionUlid, userMessage)` does: append user message → call LLM → write assistant reply → return reply.
- After this task, split into:
  - `appendUserMessage(sessionUlid, channel, text, ...)` — write-only, no LLM call. Returns void or a thin descriptor.
  - `generateAssistantReply(sessionUlid, channel)` — read history, find outstanding user messages, build LLM input, call LLM, write assistant reply, return the reply text. Lives in `ReplyOrchestratorService` (the orchestrator IS this function plus the schedule cancellation).
- All existing callers of `handleMessage` are updated to call `appendUserMessage` + `replyOrchestratorService.generateAndSendReply` in two steps. NO backward-compat wrapper. Delete `handleMessage` entirely.

Open decision points the arch-planner must resolve:
1. **`channel` attribution on history rows** — audit the current `MESSAGE#<ulid>` row schema. If `channel` doesn't exist as an attribute, propose adding it. If it does, confirm and document. This may require a small schema migration if existing rows don't have it (no production data → clean cut).
2. **Schedule naming convention** — `email-flush-<sessionUlid>`. Confirm or override.
3. **Schedule payload shape** — recommend the constant `{ sessionUlid: "<ulid>" }`. EventBridge Scheduler's payload limit is 256KB; we're nowhere near it. Confirm.
4. **Schedule auto-delete** — EventBridge Scheduler supports `ActionAfterCompletion: DELETE` on one-shot schedules so they auto-clean after firing. Recommend using it. Confirm.
5. **API Destination auth pattern** — bearer token in `X-Internal-Auth` header (static, from env var `INTERNAL_FLUSH_SECRET`). EventBridge API Destinations support this natively via the Connection's `ApiKeyAuthParameters`. Confirm this is the chosen pattern and not HMAC or OAuth.
6. **Feature flag** — recommend env var `EMAIL_DEBOUNCE_ENABLED` (default false). When false, the email webhook handler falls back to the current synchronous behavior. When true, it uses the new deferred path. Lets us deploy with safety net. Confirm.
7. **Local-dev fake scheduler** — recommend a `FAKE_SCHEDULER` env flag that swaps a real `SchedulerService` for an in-memory fake. The fake records `createSchedule`/`deleteSchedule` calls and can be inspected from tests. Confirm.
8. **Where the schedule cancellation lives in the orchestrator** — recommend it lives as the LAST step of `generateAndSendReply`, always called regardless of which channel triggered the reply. This makes the cancellation idempotent and contract-bound to the orchestrator. Confirm.
9. **`generateAndSendReply` behavior when nothing is outstanding** — recommend: log structured event `[event=reply_orchestrator_no_op_no_outstanding sessionUlid=<ulid> channel=<ch>]` and return without calling LLM or sending. Acceptable for races between cross-channel reply and scheduled fire. Confirm.
10. **Race recovery on `SchedulerService.createOrResetEmailFlush`** — concurrent inbound emails may race on delete-then-create. EventBridge Scheduler returns 404 on deleting a non-existent schedule and 409 on creating a duplicate. Recommend the service wrap both calls in idempotent error handling: swallow 404 on delete; on 409 on create, log + retry once with delete-then-create. Confirm.
11. **Auth on the flush endpoint** — recommend a new `InternalAuthGuard` in `src/guards/` that reads `X-Internal-Auth` header and constant-time-compares against `process.env.INTERNAL_FLUSH_SECRET`. 401 if missing or mismatched. Confirm.
12. **Where `appendUserMessage` lives** — recommend it stays in `ChatSessionService` (write-only refactor of part of the existing `handleMessage`). The orchestrator stays focused on the reply-generation half. Confirm.
13. **`ReplyOrchestratorService` location** — `src/services/reply-orchestrator.service.ts`. Confirm.
14. **Internal controller path** — `src/controllers/internal-email-flush.controller.ts`, route `POST /internal/email-flush/:sessionUlid`. Confirm.
15. **What channel attribution does for the LLM** — recommend: when building the LLM input from history, prefix each user message with `[via email]` / `[via web]` / `[via sms]` if cross-channel messages are present in the outstanding batch. This gives the LLM context that messages came from different channels. Optional v1 polish — confirm or defer.
16. **`SchedulerService` API surface** — recommend three methods: `createOrResetEmailFlush(sessionUlid, fireAtMs)`, `cancelEmailFlush(sessionUlid)`, `getEmailFlushFireTime(sessionUlid)` (returns null if not scheduled, for testing/debugging). Confirm or trim.

Constraints already locked by the user:
- **Debounce window:** 90 seconds. Configurable via env var (`EMAIL_DEBOUNCE_WINDOW_SECONDS`, default 90). Don't hardcode.
- **EventBridge Scheduler (NOT SQS, NOT Step Functions, NOT DDB Streams + Lambda).** Decision was deliberate.
- **History IS the buffer.** No separate "pending email batch" record. Conversation history rows carry everything.
- **Bearer-token auth on the flush endpoint** (NOT HMAC). API Destinations support this natively; HMAC adds value Twilio-style but is overkill for a single-endpoint internal callback.
- **Single chokepoint** (`ReplyOrchestratorService`) — every channel's reply path goes through it. No exceptions, no shortcuts. New channels added in the future MUST call the orchestrator.
- **Failure-mode acceptance:** crash between history write and schedule create leaves the user without a reply. Acknowledged as acceptable for v1 (rare, recoverable by user re-emailing). Monitoring sweep is a future addition if needed — NOT in this scope.
- **Schedule payload is tiny + constant** (`{ sessionUlid }`). No buffering of message content in the payload.
- **No frontend changes.** Web user-facing behavior is unchanged.
- **Feature flag with safe fallback.** New path opt-in via env var; default off; can flip back to old path instantly without code changes.
- **NO `as const`.** NO `typeof` for union narrowing. NO inline type definitions outside `src/types/`. Project style enforcer applies.
- **`Id` not `Ulid` suffix in new code** per project memory.
- **Single chokepoint discipline:** when adding the cancellation hook, it MUST live inside `ReplyOrchestratorService.generateAndSendReply` as the last step. Channels MUST NOT call cancellation directly. This is the scalability commitment.


STEP 1 — ARCHITECTURE PLANNING
Use the arch-planner agent to analyze the codebase and produce a structured implementation plan.

Task specifics for this plan:
Resolve every open decision point above and produce a step-by-step implementation order. The plan must answer:
- Exact file paths and shapes for new services (`SchedulerService`, `ReplyOrchestratorService`), the internal controller, the auth guard, and the new types.
- Exact signature of `SchedulerService.createOrResetEmailFlush` / `cancelEmailFlush` and how it handles 404/409 races from the AWS SDK.
- Exact signature and step-by-step body of `ReplyOrchestratorService.generateAndSendReply(sessionUlid, channel)`, including the schedule-cancellation step.
- Exact signature of `ChatSessionService.appendUserMessage` and how the existing `handleMessage` callers migrate to the new two-step pattern.
- The new internal flush endpoint controller — route, auth guard, body validation, handler body.
- The bearer-token auth guard — header name, env var name, constant-time comparison.
- The DDB schema audit for `channel` attribution on history rows — propose adding it if missing.
- The env vars required: `EMAIL_DEBOUNCE_ENABLED`, `EMAIL_DEBOUNCE_WINDOW_SECONDS`, `INTERNAL_FLUSH_SECRET`, `INTERNAL_FLUSH_URL`, `SCHEDULER_BACKEND`, plus IAM-related items.
- The AWS infrastructure prerequisites (NOT to be implemented in code, but documented for the user): scheduler IAM role for the app; scheduler IAM role for invoking the API destination; the Connection + API Destination in EventBridge with the bearer header.
- The local-dev fake scheduler — file location, swap mechanism.
- The feature-flag fallback path — when `EMAIL_DEBOUNCE_ENABLED=false`, email reply works the way it does today (synchronous handleMessage).
- The test strategy: which new spec files to add, which existing spec files to update, and exact descriptions for each new case. At minimum:
  - `SchedulerService` spec: create-or-reset succeeds, delete swallows 404, create handles 409 (retry once), cancel idempotent, get returns null when absent.
  - `ReplyOrchestratorService` spec: happy path (outstanding messages → reply + cancel schedule), no-op when nothing outstanding, schedule cancel called regardless of channel, errors from LLM bubble up appropriately.
  - `InternalEmailFlushController` spec: 401 on missing/wrong header, 200 on valid auth + dispatch to orchestrator, 404 on non-existent session (depends on orchestrator behavior).
  - `InternalAuthGuard` spec: pass on valid header, fail on missing/mismatched header, constant-time comparison verified.
  - `email-reply.service.spec.ts` updates: webhook handler writes to history + schedules instead of calling LLM; existing dedupe/auth/domain-routing guards still pass; feature-flag-off path unchanged.
  - `chat-session.service.spec.ts` updates: split into `appendUserMessage` cases + `generateAssistantReply` cases (latter moved to orchestrator spec).
  - `web-chat.controller.spec.ts` updates: send-message path now routes through orchestrator; pending email schedule gets cancelled when web reply fires.
  - `sms-reply.service.spec.ts` updates: same as web — orchestrator routing + cancellation hook.
  - Cross-channel integration spec: simulate email arrival → web reply → assert schedule cancelled → assert no late email fires (or fires as no-op).

Requirements for the plan:
- identify affected files/modules
- outline step-by-step implementation order
- note dependencies and architectural considerations
- list risks or edge cases (including the four concerns we already audited: 90s UX delay accepted; chokepoint enforcement; crash-between-write-and-schedule; AWS infra ops)
- define testing strategy (specific new spec cases + which existing cases need updating, with exact descriptions)

Pause after producing the plan so I can review and approve it.


STEP 2 — IMPLEMENTATION
Use the code-implementer agent to implement the approved plan.

Implementation details for this task:
Follow the plan exactly. New services in `src/services/`, new controller in `src/controllers/`, new guard in `src/guards/`, new types in `src/types/`, update env schema and config service, update all spec files per the testing strategy.

Implementation requirements:
- follow the plan produced by the arch-planner agent
- modify or create only the necessary files
- respect existing architecture and coding patterns
- focus on correctness first (style will be handled later)
- NO `as const`, NO inline type definitions outside `src/types/`, NO `typeof` for union narrowing
- All new mutable DDB attributes carry `_createdAt_` + `_lastUpdated_` per project convention (this task likely doesn't add new mutable records — confirm)
- Use `Id` not `Ulid` suffix in any newly added identifier names
- The `ReplyOrchestratorService.generateAndSendReply` chokepoint MUST be the only path to LLM + outbound. No channel handler may bypass it. Code reviewers will check this.
- Feature flag (`EMAIL_DEBOUNCE_ENABLED`) controls the new behavior; when false, the email webhook handler does what it does today
- `@aws-sdk/client-scheduler` is the new dependency — add to `dependencies` in `package.json`
- The local-dev fake scheduler lives at `src/services/scheduler-fake.service.ts` (or similar); swap is via DI based on `SCHEDULER_BACKEND` env var


STEP 3 — STYLE REFACTOR
Use the style-refactor agent to refactor the implementation according to the rules defined in `.claude/instructions/style-enforcer.md`.

Style refactor specifics:
Standard pass. Pay particular attention to:
- New service files match existing service patterns (`channel-address.service.ts`, `customer.service.ts`)
- New controller matches existing controller patterns (`web-chat.controller.ts`, `sendgrid-webhook.controller.ts`)
- New guard matches any existing guard patterns (audit `src/guards/`; if empty, follow NestJS guard conventions)
- New types in `src/types/` match existing type-file patterns (`Account.ts`, `AccountChannel.ts`, `SplashConfig.ts`)
- The orchestrator's `generateAndSendReply` body is the highest-stakes function — make sure it reads cleanly and the schedule-cancellation step is unmissable

Style requirements:
- apply all rules from style-enforcer.md
- improve readability, structure, and consistency
- align code with project conventions and standards
- do not change functionality or logic
- do not introduce new behavior


STEP 4 — TEST EXECUTION
Use the test-suite-runner agent to execute the project's test suite.

Testing context for this task:
Baseline before this task: 704/704 passing across 45 suites (master at HEAD after per-agent onboarding shipped, commit 14102a92). This task adds substantial new test coverage (scheduler service, orchestrator, internal endpoint, guard) AND modifies existing specs (email-reply, chat-session, web-chat controller, sms-reply). Total expected: meaningfully higher pass count across more suites.

Testing requirements:
- run the project's standard test command
- report all failing tests clearly
- summarize results
- do not modify code or attempt fixes


STEP 5 — CODE REVIEW
Use the code-reviewer agent to review the implementation.

Review focus for this task:
- **Chokepoint discipline.** Is `ReplyOrchestratorService.generateAndSendReply` truly the only path that calls the LLM and sends outbound? Audit every channel reply path (web, SMS, email-flush) — confirm none bypass the orchestrator. Confirm the cancellation hook is the last step of the orchestrator and is called on every code path including no-op cases.
- **Cross-channel coherence airtight.** Trace: email arrives → history write + schedule. Email 2 arrives → history write + schedule reset. Web message arrives → history write + orchestrator generates reply (sees all 3 user messages) + sends via web + cancels email schedule. T+90s: schedule was cancelled, nothing fires. Confirm no path produces a stale email reply.
- **Scheduler race handling.** Concurrent inbound emails arrive within milliseconds of each other. Both webhook handlers try delete-then-create. Confirm the service handles 404 (delete-not-found) and 409 (create-conflict) gracefully. Confirm the final state is exactly one schedule with the most-recent fire time.
- **`appendUserMessage` and `generateAssistantReply` split is clean.** No remaining callers of the deleted `handleMessage`. The two new methods have clear single responsibilities. The orchestrator's `generateAndSendReply` reads stable history (no race with concurrent writes).
- **Feature-flag fallback works.** When `EMAIL_DEBOUNCE_ENABLED=false`, the email webhook behaves exactly as it does today. Confirm by reading the conditional path.
- **Auth guard correctness.** `InternalAuthGuard` uses constant-time comparison (not `===`) to prevent timing attacks. Confirm. The bearer-token env var is required at boot (not optional) when the feature is enabled — confirm.
- **Local-dev parity.** The fake scheduler covers the same surface as the real one (`createOrResetEmailFlush`, `cancelEmailFlush`, `getEmailFlushFireTime`). Tests use the fake; production uses the real SDK.
- **Channel attribution propagates.** History rows carry `channel: "web" | "sms" | "email"`. The LLM-input builder uses this if the plan opted to add channel prefixes (decision #15 above).
- **No new DDB tables, no new attributes** beyond optional `channel` on message rows. Confirm.
- **Logging.** Every meaningful event has a structured log line (`[event=schedule_created sessionUlid=... fireAt=...]`, `[event=reply_orchestrator_no_op_no_outstanding ...]`, etc.). Operations needs grep targets.
- **Tests are sufficient and not redundant.** Confirm coverage matches the testing strategy in the plan.

Things you do NOT need to verify:
- Whether tests pass (already confirmed in step 4)
- Whether `npx tsc --noEmit` passes on touched files (already confirmed in step 2)
- The AWS infrastructure setup (IAM, API Destination) — that's user-side ops work, not code review
- Frontend implications (no frontend changes)

Review requirements:
- verify correctness of the implementation
- confirm alignment with the architectural plan
- evaluate maintainability, security, and performance
- ensure style refactor did not alter functionality
- report issues using structured review feedback


STEP 6 (post-loop, orchestrator-driven, NOT a sub-agent step) — OPS RUNBOOK FOR USER

After the test suite is green and the code-reviewer has signed off, the orchestrator produces a single-file ops runbook at `.claude/plans/email-debounce-ops-runbook.md`. Contents:
- The exact AWS infrastructure setup steps the user must perform BEFORE deploying:
  1. Create IAM role for the app to call EventBridge Scheduler (with permissions: `scheduler:CreateSchedule`, `scheduler:UpdateSchedule`, `scheduler:DeleteSchedule`, `scheduler:GetSchedule`).
  2. Create IAM role for EventBridge Scheduler to invoke the API Destination (with `events:InvokeApiDestination`).
  3. Create a Connection in EventBridge with bearer-token auth headers (`X-Internal-Auth: <secret>`).
  4. Create an API Destination targeting `https://<app-url>/internal/email-flush/*`.
  5. Generate the `INTERNAL_FLUSH_SECRET` value (random 256-bit string) and add to prod secrets.
  6. Set `EMAIL_DEBOUNCE_ENABLED=false` initially (deploy with safety net).
  7. Smoke-test with a single inbound email in staging.
  8. Flip `EMAIL_DEBOUNCE_ENABLED=true` to enable the debounce path.
  9. Monitor first few inbound bursts; rollback by flipping the flag if anything looks wrong.
- The env vars summary: names, types, defaults, where they go (`.env.example`, prod secrets).
- The rollback procedure: flip flag to false. No code redeploy needed. Old synchronous path resumes immediately.
- The monitoring guidance: structured log events to grep for in CloudWatch/Sentry, anomaly patterns to watch.
- A note that webhook signature verification on SendGrid Inbound Parse is a separate follow-up still pending (referenced from the prior journal entry).


## ADDENDUM — Email threading preservation (Message-ID + Subject)

### Why this is required (not cosmetic)

The previous plan described the missing `Message-ID` and `Subject` at schedule-fire time as a "cosmetic" corner-cut and proposed falling back to `"Re: your message"`. That characterisation is wrong for the `Subject:` line and critically wrong for the threading headers.

- `Subject:` is cosmetic. A generic fallback is jarring but survivable.
- `In-Reply-To:` and `References:` are **functional**. They are built from the inbound email's `Message-ID` header. Without them, every assistant reply lands as a brand-new email thread in Gmail and Outlook rather than as a reply to the user's original email. That defeats the entire purpose of the debounce: the user sees a fragmented inbox rather than one coherent conversation. This is unacceptable for ship.

The fix is to persist the inbound `messageId` and `subject` to session metadata at the moment the inbound email is received — the same moment `appendUserMessage` is called — so the orchestrator can read them back 90 seconds later when the schedule fires.

### Schema addition — `ChatSessionMetadataRecord` (`src/types/ChatSession.ts`)

Add two optional fields to the `ChatSessionMetadataRecord` interface:

```
last_inbound_email_message_id?: string;
last_inbound_email_subject?: string;
```

Both are optional because:
- Web and SMS sessions never set them.
- They are absent on session creation; they are set (and overwritten) on every inbound email.
- The orchestrator treats their absence as a defensive fallback signal (see below).

### `appendUserMessage` signature change (`src/services/chat-session.service.ts`)

Extend the signature with a fourth, optional parameter:

```ts
appendUserMessage(
  sessionUlid: string,
  channel: "web" | "sms" | "email",
  text: string,
  emailContext?: { messageId: string; subject: string },
): Promise<void>
```

Web and SMS callers pass `undefined` (no change to call sites). Email callers pass `{ messageId, subject }` extracted from the same variables already in scope at every call site.

When `emailContext` is present, the `UpdateExpression` on the METADATA record additionally sets:

```
last_inbound_email_message_id = :mid
last_inbound_email_subject    = :sub
```

alongside the existing `_lastUpdated_` update. These two attributes are set unconditionally on every inbound email (not `if_not_exists`) — the most-recently-received email always wins, which is correct because the orchestrator will reply to the last message the user sent.

### `EmailReplyService` call-site updates (4 sites)

All four places that currently call `chatSessionService.handleMessage` will migrate to `appendUserMessage` (per the main plan). The addendum requires that each of those 4 call sites also passes `emailContext`. In every case, `messageId` and `formFields.subject` are already in scope:

1. **`processInboundReply`** (line 262 in current source) — `messageId` is resolved from `deduplicateInboundEmail`; `formFields.subject` is available directly.
2. **`handleCase2NewSession`** (line 463) — `messageId` is a parameter; `formFields.subject` is available from `formFields`.
3. **`handleCase3FreshAttach`** (line 529) — `messageId` is a parameter; `formFields.subject` is available from `formFields`.
4. **`handleCase3StaleNewSession`** (line 602) — `messageId` is a parameter; `formFields.subject` is available from `formFields`.

No new data extraction is required at any call site — both values are already captured before the point of call.

### Orchestrator outbound build — schedule-fire path (`src/services/reply-orchestrator.service.ts`)

In `generateAndSendReply`, step 13 ("send outbound"), when `channel === "email"` AND `sendContext` is `null` (the schedule-fire path, where no live webhook context is available), the orchestrator builds the outbound email using the session metadata it already reads in step 4. Extend that existing metadata read to consume two additional fields:

**Subject construction:**
```
rawSubject = metadata.last_inbound_email_subject ?? ""
replySubject = rawSubject.startsWith("Re:") ? rawSubject : `Re: ${rawSubject}`
```
This matches the identical logic already present in `email-reply.service.ts` lines 264–265, 465–466, 531–532, and 604–605.

**Threading headers:**
```
inReplyToMessageId = metadata.last_inbound_email_message_id
referencesMessageId = metadata.last_inbound_email_message_id
```
These are passed to `emailService.send(...)` as `inReplyToMessageId` and `referencesMessageId`, matching the existing pattern in `email-reply.service.ts` lines 267–274.

**Defensive fallback** — if either `last_inbound_email_message_id` or `last_inbound_email_subject` is absent (should never happen if the flow is intact, but guards against a crash between history write and metadata write, or a session created before this code shipped):

- Log a structured error: `[event=email_flush_missing_threading_context sessionUlid=<ulid>]`
- Use `replySubject = "Re: your message"`
- Omit `inReplyToMessageId` and `referencesMessageId` from the `emailService.send` call

The reply still goes out, but as a new thread. This is the same behaviour the previous plan described as "v1 acceptable" — the difference is that it is now the **fallback for a defensive edge case**, not the primary path.

### Scope assessment

This addition does NOT change the architecture or the scope of the main implementation task. It adds approximately 15 lines of production code across three locations:

| Location | Change |
|---|---|
| `src/types/ChatSession.ts` | 2 optional fields on `ChatSessionMetadataRecord` |
| `src/services/chat-session.service.ts` | Optional `emailContext` parameter; conditional `UpdateExpression` branch in `appendUserMessage` |
| `src/services/email-reply.service.ts` | 4 call sites each pass `{ messageId, subject: formFields.subject ?? "" }` to `appendUserMessage` |
| `src/services/reply-orchestrator.service.ts` | Step 13 reads two metadata fields and uses them to build outbound subject + threading headers |

All four of the modified locations are already in scope in the main plan. No new files are required.

### Test cases to add

**`src/services/chat-session.service.spec.ts`** — inside the `appendUserMessage` describe block:

- "when channel is 'email' and emailContext is provided, writes `last_inbound_email_message_id` and `last_inbound_email_subject` to the METADATA UpdateExpression"
- "when channel is 'web', does NOT include `last_inbound_email_message_id` or `last_inbound_email_subject` in the UpdateExpression"

**`src/services/email-reply.service.spec.ts`** — one new describe block:

- "passes emailContext `{ messageId, subject }` to appendUserMessage in case 1 (processInboundReply path)"
- "passes emailContext `{ messageId, subject }` to appendUserMessage in case 2 (handleCase2NewSession)"
- "passes emailContext `{ messageId, subject }` to appendUserMessage in case 3 fresh (handleCase3FreshAttach)"
- "passes emailContext `{ messageId, subject }` to appendUserMessage in case 3 stale (handleCase3StaleNewSession)"

**`src/services/reply-orchestrator.service.spec.ts`** — extend the email-channel describe block:

- "email channel with null sendContext reads `last_inbound_email_message_id` from metadata and passes it as `inReplyToMessageId` and `referencesMessageId` to emailService.send"
- "email channel with null sendContext reads `last_inbound_email_subject` from metadata and builds outbound subject as 'Re: \<subject\>' when subject does not already start with 'Re:'"
- "email channel with null sendContext uses subject as-is when it already starts with 'Re:'"
- "email channel with null sendContext logs `[event=email_flush_missing_threading_context]` and falls back to 'Re: your message' subject with no threading headers when `last_inbound_email_message_id` is absent from metadata"
