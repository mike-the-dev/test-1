# Project journal

Narrative log of meaningful milestones on `ai-chat-session-api`. Newest entries on top.

This file is the **story** of the project — what we set out to do, what we decided, what's next. It is intentionally different from the reference docs under [`docs/reference/`](./README.md), which describe the system as it exists right now. Reference docs answer *"what is this?"*; the journal answers *"how did we get here and where are we going?"*.

---

## How to add an entry

At the end of a working session — or after shipping a meaningful milestone — append a dated section at the **top** of the entries below. Keep it tight.

**Format:**

```
## YYYY-MM-DD — short title

**Goal:** one sentence on what we set out to do.

**What changed:**
- 3–6 bullets of the meaningful outcomes (not every file touched).

**Decisions worth remembering:**
- 0–3 bullets of non-obvious calls and *why* we made them.

**Next:**
- 0–3 bullets of what a future session would pick up.
```

**Rules of thumb:**

- One entry per meaningful milestone, not per session. Building the email reply loop deserves an entry. Renaming a variable does not.
- Favor *why* over *what*. The diff shows what changed. The journal should capture the reasoning that doesn't survive in the code.
- Keep each entry under ~30 lines. If it's longer than that, it's trying to be a spec — put it in `docs/reference/` instead.
- When this file crosses ~500 lines, cut the oldest third into `docs/journal-archive-<year>.md` and link it from the bottom of this file.

---

## 2026-05-12 — Email reply debounce with cross-channel coherence (90s window)

**Goal:** Stop the email channel from producing janky, out-of-order replies when a user sends multiple emails in rapid succession. Pre-fix, every inbound email synchronously triggered `chatSessionService.handleMessage` → 3 rapid emails meant 3 concurrent LLM round-trips racing on session history writes, 3 outbound replies arriving in semi-random order, each answering only a fragment. After this phase: inbound emails are written to history immediately (history is now the buffer), but the LLM-and-reply step is deferred via a 90-second EventBridge Scheduler debounce window. New emails reset the timer. When the timer fires, ONE consolidated reply covers all outstanding user messages. If the user switches to another channel (web/SMS) mid-burst, that channel's reply consumes ALL pending user messages across channels into one reply AND cancels the pending email schedule — no stale email reply ever lands. Cross-channel coherence is airtight because every reply path on every channel routes through a single chokepoint (`ReplyOrchestratorService.generateAndSendReply`) that owns the cancellation contract.

**What changed:**
- New `ReplyOrchestratorService` (~330 lines) is the single chokepoint for LLM-call + outbound-send + cross-channel cancellation. The orchestrator reads conversation history, finds user messages after the last assistant reply, runs the tool loop, writes the assistant reply, sends outbound via the channel specified, and cancels any pending email schedule for the session as the LAST step of every code path (happy path, no-op-nothing-outstanding path, AND LLM-error path — the cancel is wrapped in try/finally, with cancel errors swallowed so they never mask the original exception).
- New `SchedulerService` (~140 lines) wraps `@aws-sdk/client-scheduler` with three methods: `createOrResetEmailFlush` (delete-then-create with `ConflictException` retry-once handling), `cancelEmailFlush` (idempotent, swallows 404), `getEmailFlushFireTime` (parses `at(...)` expressions back to epoch ms). One-shot schedules use `ActionAfterCompletion: "DELETE"` so fired schedules auto-clean themselves. Plus an in-memory `SchedulerFakeService` swapped in for local dev and tests via the `SCHEDULER_BACKEND` env var.
- `ChatSessionService.handleMessage` deleted entirely. Split into `appendUserMessage` (write-only, no LLM, channel-aware) on `ChatSessionService`, plus reply generation moved to the orchestrator. All 7 prior `handleMessage` call sites migrated. `grep -r "handleMessage" src/` returns zero results.
- New `InternalEmailFlushController` (`POST /internal/email-flush/:sessionUlid`) is the auth'd EventBridge callback endpoint, gated by a new `InternalAuthGuard` that uses `timingSafeEqual` constant-time comparison against `INTERNAL_FLUSH_SECRET` from env. The secret is required at boot via Zod `min(1)` so missing-env-var fails fast at startup rather than silently 401ing every callback in production.
- Email threading preserved across the debounce window: `appendUserMessage` (when channel === "email") writes the inbound `Message-ID`, `Subject`, `reply_domain`, and `from_name` to the session METADATA record in the same UpdateExpression as the existing `_lastUpdated_`. When the schedule fires 90s later, the orchestrator reads those fields back and passes them to `emailService.send` as `inReplyToMessageId`/`referencesMessageId`/`replyDomain`/`fromName`. Defensive fallback: missing fields log an event and fall back to subject "Re: your message" with no threading headers — better than dropping the reply entirely. Reviewer caught this `replyDomain`/`fromName` gap during code review; the email-threading fields had been threaded through earlier via an ADDENDUM but the SendGrid-from fields were missed — fixed before merge.
- Feature flag `EMAIL_DEBOUNCE_ENABLED` (default false) gates the debounce path. When false, the email webhook handler still calls `appendUserMessage` (history writes always synchronous) AND still routes through the orchestrator (chokepoint discipline preserved in both modes) — the only difference is whether a schedule is created or the orchestrator is invoked synchronously. Flipping the flag does not require a code redeploy.
- `wrapInHtml` helper extracted to `src/utils/email/wrap-in-html.ts` and consumed by both `email-reply.service.ts` and `reply-orchestrator.service.ts` (eliminates duplication that would have otherwise crept in).
- Test suite: 724 / 51 suites / 0 failures (was 704 / 45 pre-phase, +20 tests across 6 new spec files and 4 updated specs). Build clean.
- `.env.example` created with safe placeholder defaults for the new env vars.
- AWS infrastructure prerequisites (IAM role for app, IAM role for scheduler, EventBridge Connection with bearer-token auth, API Destination) are user-side ops captured in the separate runbook at `.claude/plans/email-debounce-ops-runbook.md`.

**Decisions worth remembering:**
- **History is the buffer.** No separate "pending message batch" DDB record. Conversation history rows carry channel attribution; the orchestrator queries history and finds outstanding user messages after the last assistant reply. EventBridge Scheduler's payload is constant and tiny (`{ sessionUlid }`); it's a wake-up mechanism, not a state store. This keeps the buffer queryable, free of size limits, and naturally aligned with how the rest of the conversation state already works.
- **EventBridge Scheduler chosen over SQS deliberately.** SQS's `DelaySeconds` is per-message and uncancellable; you can't "reset the timer." Scheduler supports named, cancellable, replaceable one-shot schedules — exactly the debounce semantics we needed. SQS would have required N flushes for N messages, defeating the point. Step Functions, DDB Streams + Lambda, and other alternatives were considered and rejected as over-engineering for the volume.
- **Single chokepoint discipline is the scalability commitment.** Every channel (web, SMS, email) routes through `ReplyOrchestratorService.generateAndSendReply`. Adding a future channel (Discord, Slack, WhatsApp, etc.) means calling the orchestrator — there is no path that bypasses it. The cancellation contract is owned by the orchestrator, not the channel handlers; new channels inherit cross-channel coherence for free. This was the user's explicit north-star requirement and is enforced by the architecture (not just by convention).
- **Cancellation in try/finally is non-negotiable.** If LLM call throws, the schedule that just fired or is about to fire MUST still get cancelled — otherwise a future web reply races with a phantom-existence schedule, producing stale email replies. Wrapping the cancel in finally with its own try/catch (to swallow cancel errors without masking the original exception) is the airtight pattern. Tests explicitly verify all three paths: happy, LLM-error, and cancel-itself-throws.
- **90-second debounce window** is the sweet spot for email. Long enough to catch rapid follow-ups from a user composing thoughts in multiple emails; short enough that the reply still feels timely. The window is env-var configurable (`EMAIL_DEBOUNCE_WINDOW_SECONDS`) so it can be tuned post-deploy without code changes. Each new inbound email resets the timer to `now + 90s` (not "add 90s to existing fire time").
- **Bearer-token auth on the internal flush endpoint** (not HMAC). EventBridge Scheduler's API Destination feature supports static API-key auth natively (`X-Internal-Auth: <secret>` header). HMAC would have required custom signing infrastructure for a single-purpose internal endpoint with one caller; bearer-token is the right level. The guard mirrors the existing `InternalApiKeyGuard` pattern exactly.
- **`SchedulerService` injection via string token + factory swap.** Real `SchedulerService` and `SchedulerFakeService` share an `ISchedulerService` interface defined in `src/types/Scheduler.ts`. `app.module.ts` factory provider reads `process.env.SCHEDULER_BACKEND` at boot and selects the implementation. Tests use the fake; staging/prod use the real. This pattern keeps integration tests off of real AWS and gives local dev parity.
- **Channel-originated session subject/from data must be persisted at inbound time, not derived later.** This was the late catch during review: the orchestrator fires 90s after inbound and has no original webhook context. Persisting `last_inbound_email_message_id`, `last_inbound_email_subject`, `reply_domain`, and `from_name` on the session METADATA record at `appendUserMessage` time was the cleanest fix — same UpdateExpression, four extra attributes, no separate write. The pattern is now established for any future "context at receive time that we need at send time" gap.
- **The orchestrator's return type is a discriminated union** so the web channel can extract the reply text and tool outputs from the same chokepoint that email and SMS callers use (they ignore those fields). One method, three channels, no separate web-only method — the chokepoint discipline holds.
- **No backfill needed.** No production data exists for the email-debounce path. The `channel`/`last_inbound_email_*`/`reply_domain`/`from_name` attributes on session METADATA are new and optional; old records simply lack them and the orchestrator's defensive fallback covers that case.
- **Pre-shipping security gap acknowledged, not fixed in this scope.** SendGrid Inbound Parse webhook still has no signature verification. Twilio inbound already does. This was flagged as a separate follow-up in prior journal entries and remains the right next security item. Not blocking for this phase.

**Next:**
- **User-side prerequisites BEFORE flipping `EMAIL_DEBOUNCE_ENABLED=true`:**
  1. Create IAM role for the app with `scheduler:CreateSchedule`/`UpdateSchedule`/`DeleteSchedule`/`GetSchedule` permissions.
  2. Create EventBridge Scheduler execution role (trusted by `scheduler.amazonaws.com`) with `events:InvokeApiDestination` on the API Destination ARN.
  3. Create EventBridge Connection with bearer-token auth (`X-Internal-Auth: <INTERNAL_FLUSH_SECRET>`).
  4. Create EventBridge API Destination targeting `https://<app-url>/internal/email-flush/*`.
  5. Generate `INTERNAL_FLUSH_SECRET` (32+ char random), store in prod secrets.
  6. Set `SCHEDULER_ROLE_ARN`, `SCHEDULER_API_DESTINATION_ARN`, `INTERNAL_FLUSH_SECRET`, `SCHEDULER_BACKEND=real` in prod env.
  7. Deploy with `EMAIL_DEBOUNCE_ENABLED=false`. Verify app boots, sync path still works.
  8. Smoke-test by sending a single inbound email in staging.
  9. Flip `EMAIL_DEBOUNCE_ENABLED=true`. Monitor first few bursts. Rollback by flipping back to false (no code redeploy needed).
- The full runbook is at `.claude/plans/email-debounce-ops-runbook.md`.
- **SendGrid webhook signature verification** is the highest-priority remaining security item. Now that the email pipeline has matured (debounce + threading + cross-channel coherence), it deserves to be hardened.
- **Architecture diagrams** still queued (overdue per prior journal entries).
- **Per-customer onboarding persistence** still a build-later (no real-user demand yet).

---

## 2026-05-07 — Per-agent onboarding configuration: splash + budget collection becomes agent-driven

**Goal:** Stop the widget's pre-chat splash + budget collection step from running for every session of every agent. Pre-fix, the splash was hardcoded — `shopping_assistant` and `lead_capture` both went through it, even though `lead_capture` has no use for a budget. Future non-commerce agents (appointment booking, support, etc.) would have hit the same wrong default. After this phase, every agent declares its own `splash: SplashConfig | null`; `null` means no splash at all and the embed goes straight to chat. The Zod validation schema for `POST /onboarding` is now constructed dynamically per request from the agent's declared fields, so there is exactly one source of truth for both rendering and validation.

**What changed:**
- New `ChatAgent.splash: SplashConfig | null` (REQUIRED, not optional — every agent author must make an explicit choice). New `SplashConfig = { fields: SplashConfigOnboardingField[] }`. New discriminated union `SplashConfigOnboardingField` with three variants today (`budget`, `industry`, `shortText`) — only `budget` actually used. Adding a new variant is one entry in the union + one frontend renderer.
- New pure helper `buildOnboardingSchema(fields)` in `src/validation/` constructs a `z.object(...)` per request from the field array. Per variant: `budget` → `z.number().int().positive().max(MAX_BUDGET_CENTS)`; `industry` → `z.enum([...field.options])`; `shortText` → `z.string().min(1).max(field.maxLength)`. `required: false` adds `.optional()` chained. Empty `options` on `industry` throws synchronously (developer-time guard, never a user-facing error). 13 new unit tests cover every variant × required/optional × edge cases.
- `web-chat.controller.ts` `completeOnboarding` rewritten to an 8-step flow: `getSessionMetadata` (404 if absent) → registry lookup (400 if agent unknown) → splash null-check (400 with "this agent has no onboarding") → build dynamic schema → `safeParse` (400 on Zod failure) → `updateOnboarding` with the parsed (stripped) data, never the raw body. The two-stage validation (outer wrapper at the pipe layer, inner content at the controller layer) keeps unknown keys out of DDB without any `.strip()` ceremony.
- `createSession` response now carries `splash: SplashConfig | null` (copied from `agent.splash`) and `onboardingData: Record<string, unknown> | null` (the persisted map, or null for fresh sessions). The old top-level `budgetCents` field is gone from the API entirely. Frontend reads `splash` and renders conditionally — `null` skips the splash entirely, non-null iterates `splash.fields` and renders one input per `kind`.
- DDB `ChatSessionMetadataRecord` replaces top-level `budget_cents?: number` with `onboarding_data?: Record<string, unknown>` map. New write path stores the parsed-from-Zod map keyed by each field's `key` property. System prompt builder in `chat-session.service.ts` now reads `onboarding_data?.budgetCents` from the map and injects the same `User context: shopping budget is approximately $X` line as before. The `Number(rawBudget)` coercion is guarded against the `null → 0` trap with an explanatory comment so a future contributor doesn't "simplify" the guard and silently introduce a $0 budget bug.
- New `getSessionMetadata(sessionUlid)` on `SessionService` returns `{ agentName } | null` — minimal shape, only what the controller needs. Replaces the prior implicit "session existence check via DDB ConditionExpression" pattern with an explicit upfront read.
- `shopping_assistant` declares `splash = { fields: [{ kind: "budget", key: "budgetCents", label: "What's your approximate budget?", required: true }] }`. `lead_capture` declares `splash = null` and skips the splash entirely.
- All channel-originated session paths (SMS, email cold-entry) are unaffected at the behavior level — splash is web-chat-only by design. SMS/email session writes already produce records with no `onboarding_data`, and the system prompt builder cleanly skips budget-context injection in that case.
- Test suite: 704 / 45 suites / 0 failures (was 680 / 44 pre-phase, +24 tests). Build clean.
- `.claude/plans/per-agent-onboarding.md` written and updated with the full arch-planner output as the authoritative reference for this phase.

**Decisions worth remembering:**
- **The agent class is the single source of truth for everything about that agent.** System prompt, allowed tools, splash config — all in one TypeScript file. No agent-config DB table, no env vars, no JSON config sprinkled across the repo. Reading `shopping-assistant.agent.ts` tells you exactly what the user sees and what the system enforces.
- **Validation is derived from the spec, not duplicated alongside it.** `buildOnboardingSchema(agent.splash.fields)` constructs the Zod schema per request from the agent's declared fields. The frontend's render rules and the backend's Zod validation come from the same declaration; they cannot drift. This is the architectural commitment that makes the system scale to N agents without a corresponding N validation files. The user grasped this immediately ("you're treating the field object as the contract that Zod respects") and locked the design in one round.
- **`splash: SplashConfig | null` is required, not optional.** A new agent author who omits `splash` gets a TypeScript compile error — they cannot accidentally fall through to "default behavior." The opt-in/opt-out decision is forced at the type level.
- **`OnboardingField` ships with three variants from day one even though only one is used.** The other two (`industry`, `shortText`) prove the architecture supports more than one variant — confirmed by the `buildOnboardingSchema` spec coverage — and make the contract self-documenting for the next agent author.
- **Storage is a generic `Record<string, unknown>` map, not per-field columns.** Adding agent N+1 with new field types adds zero DDB schema migrations and zero validation files; the map shape absorbs whatever the agent declares. The system prompt builder reads specific keys (`budgetCents`) at the read site and casts/coerces there, not at the storage boundary.
- **Channel-originated sessions skip splash entirely.** Splash is a web-chat-only concept; SMS/email inbound sessions go directly from creation to chat without any onboarding step. A returning customer who first contacted via SMS and later opens the web chat WILL see the splash on their first web visit (no per-customer onboarding persistence today). If real users complain, persist `onboarding_data` on the customer record and copy into new sessions on `collect_contact_info` match — that's a follow-on feature, not part of this phase.
- **No production data migration was needed.** No prod data exists yet. The `budget_cents` → `onboarding_data` shape change is a clean cut. If production data had existed, the choice would have been a one-time DDB scan + transform.
- **Dynamic Zod schema construction per request was a "wow that's possible" moment.** It's standard schema-derivation pattern (think `react-jsonschema-form`) but had not been used in this codebase before. The pattern is now established here for any future feature that wants the same agent-declares-once-derived-everywhere shape.

**Next:**
- **Frontend handoff doc** — to be produced as a single-paste drop-in for the frontend agent at `.claude/plans/per-agent-onboarding-frontend-handoff.md`. Contains the new API contracts, the `SplashConfig`/`OnboardingField` union shape, render-time logic (`splash === null` → skip; otherwise iterate fields by `kind`), submission flow, and error handling. The frontend repo is separate; coordinated cutover not needed because no production data exists — embed and backend deploy independently.
- **Pre-existing follow-ups still queued** (deliberately deferred):
  - Architecture diagrams in `docs/reference/architecture-diagrams.md` — overdue. Three major phases since the request (SMS, multi-tenant routing, E.164 normalization, now per-agent onboarding).
  - Web chat security roadmap — Referer + CSP `frame-ancestors` work, planned to follow the accountUlid lookup swap (which has shipped).
  - Per-customer onboarding persistence — copy `onboarding_data` from customer record into new sessions on returning-visitor match. Build-later, only if real users complain.
  - Knowledge base benchmark phase — in progress with real dog-walking-company data.
  - Attribution ecommerce-backend follow-up — `aiSessionId` is being emitted from this codebase but the e-commerce store side hasn't been extended to close the loop.

---

## 2026-05-06 — E.164 phone normalization in `collect_contact_info`: cross-channel identity hole closed

**Goal:** Normalize LLM-supplied phone numbers to canonical E.164 form before they reach DynamoDB or the customer GSI2 lookup key. Pre-fix, an LLM-collected phone like `(415) 555-1234` would be written raw to `USER_CONTACT_INFO` and to the customer record; on a later inbound SMS Twilio supplies the same number as `+14155551234`, so the GSI2 `PHONE#<phone>` lookup misses, a duplicate customer is created, and the cross-channel identity link breaks. The bug was deliberately deferred during the prior multi-tenant routing phase; closing it now finishes the lookup loop end-to-end.

**What changed:**
- New pure helper `src/utils/phone/normalizeToE164.ts` (~13 lines) wrapping `parsePhoneNumberFromString` from `libphonenumber-js/min` (~75 KB). Signature `(input: string, defaultRegion: CountryCode = "US") => string | null`. Trims, parses, returns the E.164 form or `null` on invalid input. Default region is hardcoded `"US"` per user direction — non-US support is a future concern.
- `collectContactInfoInputSchema` in `src/validation/tool.schema.ts` gained a `.transform()` on the `phone` field. Single chokepoint: any value reaching `safeParse` is normalized to E.164 or dropped to `undefined`. Tool body, customer service, and GSI2 key construction all consume the normalized form by transitive guarantee.
- `collect-contact-info.tool.ts` got one new behavior: when the raw input had a `phone` but the validated output dropped it, log `[event=collect_contact_info_phone_normalization_failed sessionUlid=...]` at warn level. The Zod transform can't access the logger (no DI inside schemas), so the detection lives in the tool body. Guard pattern is `Object(input).phone && validated.phone === undefined` — coerces any unknown value to an object so `.phone` access is safe without a TypeScript cast. One-line comment documents the pattern.
- `customer.service.ts` got a 2-line contract comment above the `gsi2Fields` build site documenting that callers must supply phone in canonical E.164 form. No logic change — the service stays a dumb pass-through.
- 7 helper unit tests + 6 new tool spec cases (16–21). Fixed one pre-existing test (case 10) whose fixture used an unparseable 7-digit number; updated to a valid 10-digit (`4155551234` → `+14155551234`).
- Test suite: 680 / 44 suites / 0 failures (was 667 / 43 pre-phase, +13 tests).

**Decisions worth remembering:**
- **Normalization belongs in the Zod schema, not the tool body.** The schema is the contract; placing the transform there guarantees every consumer of `collectContactInfoInputSchema` gets normalized output without needing to remember to call the helper. Future tools or services that adopt the schema get the behavior for free.
- **Unparseable phones are silently dropped, not errored.** The trio gate (firstName + lastName + email) is what unblocks customer linking — phone is only a secondary identifier. Returning `isError: true` would discard a valid name/email collected in the same call. The warn log gives ops a grep target if the LLM starts producing garbage at scale.
- **Default region is hardcoded `"US"` in the helper signature, not threaded from per-account config.** Confirmed acceptable for current account base. When non-US accounts arrive, the helper signature already accepts an optional second argument; the schema/tool layer would need to thread an account-level region through.
- **`customer.service.ts` stays a pass-through.** No normalization in the service. Putting it in the schema means there's only one place phone normalization can live, which prevents the hidden-coupling failure mode where service callers and schema callers normalize differently.
- **Backfill of pre-existing un-normalized phones is out of scope.** Window of exposure is narrow: customer records only get a phone after the trio gate, which means firstName + lastName + email all had to be supplied in the same session before any LLM-collected phone reached a customer record. Historical exposure is small. A targeted DDB scan + update is the right mechanism if needed and belongs as a separate operational item.

**Next:**
- **No user-side prerequisites.** This phase is code-only. No env var changes, no account record changes, no DDB migration required for the fix to take effect on new sessions.
- **Pre-existing follow-ups still queued:**
  - Architecture diagrams (Mermaid in `docs/reference/architecture-diagrams.md`) — overdue. Two major phases have shipped since the original request (multi-tenant routing, then this).
  - Per-agent onboarding configuration — splash/budget collection is forced on every agent today; needs to become agent-driven before non-commerce agents ship to prod.
  - Attribution ecommerce-backend follow-up: `aiSessionId` is being emitted from this codebase but the e-commerce store side hasn't been extended to close the loop.
  - SendGrid webhook signature verification (parity with Twilio).

---

## 2026-05-06 — Multi-tenant channel routing: account-aware email + SMS, 6 single-tenant env vars deleted

**Goal:** Replace all single-tenant routing env vars (`SENDGRID_REPLY_ACCOUNT_ID`, `SENDGRID_REPLY_DOMAIN`, `SENDGRID_FROM_EMAIL`, `SENDGRID_FROM_NAME`, `TWILIO_REPLY_ACCOUNT_ID`, `TWILIO_PHONE_NUMBER`) with dynamic per-account channel configuration sourced from the account record + new index records under each account's PK. After this phase, both email cold-entry (`assistant@<reply-domain>`) and SMS inbound work for any number of customer accounts concurrently — the architectural prerequisite for deploying SMS to more than one production tenant. It also retroactively unblocks email cold-entry, which was deployed but functionally unreachable in production because `SENDGRID_REPLY_ACCOUNT_ID` was never set.

The architecture was locked in a long brainstorming arc with the user. Key calls along the way:
- **Index records under the account PK, not top-level.** The shape that won was `PK: A#<accountUlid>, SK: <CHANNEL_TYPE>#<address>` for cleanup-via-Query and multi-address-per-account, with GSI1 multiplexing for fast inbound routing. Top-level standalone records were considered first but rejected because they were relationally orphaned and made account-cleanup intractable.
- **GSI1 multiplexing, not a new GSI.** The existing GSI1 already carries `DOMAIN#<host>` (account itself) and `ACCOUNT#<accountUlid>+EMAIL#<email>` (customer record). The new patterns `EMAIL_REPLY_DOMAIN#<domain>` and `TWILIO_NUMBER#<E.164>` are added alongside. High cardinality of the new PK patterns (one PK per address) means each lookup hits its own GSI partition; no hot partition possible. Confirmed scalable to 1M+ accounts via DynamoDB's native partitioning. A new GSI3 was rejected as redundant.
- **Nested `channels` config block on the account record.** `channels.email.reply_domains[]`, `channels.email.reply_local_part`, `channels.email.from_name`, `channels.sms.phone_numbers[]`. Mirrors the existing `status: { is_active }` nested-object precedent. The account record is the source-of-truth for "what addresses does this account own"; index records are the inverse-lookup mechanism.

**What changed:**
- New `ChannelAddressService` (~315 lines) owns the address ↔ account mapping via three methods: `getAccountByChannelAddress` (GSI1 Query + entity filter), `provisionChannelAddress` (TransactWriteCommand: Put index record with `attribute_not_exists` + Update account's array via `list_append(if_not_exists(...))`), `deprovisionChannelAddress` (GetItem-then-TransactWrite: read account record, locate target address's index in the array via `indexOf`, REMOVE at that exact index in a single TransactWrite). The service uses a module-level type predicate `isTransactionCanceledError` to narrow DDB errors without inline annotations on `const` (banned pattern). 23 spec tests cover happy paths, race recovery, multi-address provisioning/deprovisioning edge cases, and `TransactionCanceledException` cancellation-reason index parsing.
- New types: `src/types/Account.ts` (the previously implicit account-record shape made explicit), `src/types/AccountChannel.ts` (`ChannelAddressType` enum, `AccountChannelsConfig` and sub-types, `AccountChannelAddressRecord`, plus the four type-narrowing types used by the service).
- `EmailReplyService` restructured: `processInboundReply`'s outer loop no longer filters the inbound `To:` addresses by a configured domain — it takes the first parseable address, extracts the domain, and passes `{ localPart, domain }` to classification. `EmailReplyLocalPartClassification.ASSISTANT_ENTRY` renamed to `DOMAIN_ROUTED`; the dead `UNRECOGNIZED` member was removed. `handleAssistantEntry` renamed to `handleDomainRoutedEntry`: looks up the account by domain via `ChannelAddressService`, GetItems the account record, validates the inbound local-part against the account's `channels.email.reply_local_part` (default `"assistant"` for backward compat), then routes to the existing Case 2/3 paths with the resolved `accountUlid`. Outbound replies pass per-account `replyDomain` and `fromName` to `EmailService.send`. Multi-address `To:` test added (CC scenario) — first parseable address wins.
- `SmsReplyService` Phase 1 rewrite: replaced `this.twilioConfig.replyAccountId` env-var read with `channelAddressService.getAccountByChannelAddress("twilio_number", formFields.To)`. On null return → `rejected_unknown_account`. Outbound `smsService.send(...)` calls now pass `from: formFields.To` (by definition the account-owned Twilio number).
- Transport-service signature changes: `EmailSendParams.replyDomain` and `EmailSendParams.fromName` are OPTIONAL (so `send_email.tool.ts` and `request-verification-code.tool.ts` continue to compile unchanged — Option A from the planner). When absent, `EmailService.send` falls back to SendGrid's account-default verified sender. `SmsSendParams.from` is REQUIRED (every SMS send call site has the number to hand). `EmailSendGridSdkError` and `SmsTwilioSdkError` types added in `src/types/Email.ts` and `src/types/Sms.ts` for catch-block narrowing without inline annotations.
- Config service trims: `SendGridConfigService` now exposes only `apiKey`. `TwilioConfigService` now exposes only `accountSid`, `authToken`, `publicWebhookUrl`. Six getters were dropped across the two services. `configuration.ts` lost six config keys. `env.schema.ts` lost five Zod entries (`SENDGRID_REPLY_ACCOUNT_ID` was never in `env.schema.ts` to begin with — pre-existing gap, silently fixed by the env var going away).
- `app.module.ts` registers `ChannelAddressService` as a provider; both `EmailReplyService` and `SmsReplyService` inject it.
- A reviewer-driven close-out cycle fixed three SHOULD FIX items: an inline `const` annotation that snuck back in, a hardcoded `[0]` array index in `deprovisionChannelAddress` that would corrupt the array for accounts with multiple addresses, and a dead `UNRECOGNIZED` enum value. The deprovision fix turned the operation from one TransactWrite to GetItem-then-TransactWrite — non-atomic, but acceptable for the admin-only, low-frequency deprovisioning use case (documented in JSDoc). The fix added 4 new tests covering second-of-two-addresses, only-address, address-not-in-array, and GetCommand-failure paths.
- Build clean. Test suite green: 667 / 43 suites / 0 failures (was 635 / 41 pre-phase, +32 tests including the close-out's +4).

**Decisions worth remembering:**
- **GSI1 multiplexing scales horizontally because the new PK patterns have very high cardinality.** Each `EMAIL_REPLY_DOMAIN#<domain>` and `TWILIO_NUMBER#<E.164>` is its own GSI partition. Inbound routing is a single-key point-lookup with `Limit: 1`, RCU-equivalent to a `GetItem`. At 1M+ accounts the system parallelizes naturally; no hot-partition concern. This is the canonical single-table design pattern: GSIs are global indexes across the table, multiplexed by record-type-discriminating PK patterns. Adding GSI3 was considered and rejected as redundant.
- **Index records sit UNDER the account PK rather than top-level.** Top-level was the first design considered; it was rejected because it left the index records relationally orphaned (nothing in the data model tied them back to an account, making cleanup require either a scan or app-side bookkeeping). The chosen shape (index records as children of the account partition) makes account-cleanup a single `Query(PK = A#<ulid>)` + `BatchDelete`, multi-address-per-account just a new SK under the same PK, and routing a fast GSI1 Query.
- **The hot-path optimization argument was the wrong axis to optimize on.** A late-stage alternative shape (index records at top-level PK, GSI1 keyed back on account ULID) was considered because it would have made inbound routing a `GetItem` instead of a `GSI Query`. The latency difference is single-digit milliseconds — invisible compared to the ~2-5s LLM call latency on every conversation turn. The user's real priorities (account-first relational coherence, clean delete cascade, multi-address support) outweighed the latency micro-optimization. Locked Shape A.
- **Tools that send email don't get per-account branding for v1.** `send_email.tool.ts` (lead capture's email-send tool) and `request_verification_code.tool.ts` (verification code email) call `emailService.send` without account context. Making `replyDomain`/`fromName` optional and falling back to SendGrid's account-default verified sender keeps these tools untouched. Per-account branding for tool-originated sends is a future phase if customer feedback warrants it; for v1 the verification code email arriving from `noreply@instapaytient.com` instead of `assistant@reply.acmestore.com` is an acceptable degradation.
- **Migration of the existing `reply.instapaytient.com` account is user-side.** The implementer did NOT script the migration. The plan documents the manual steps: update the production account record's `channels.email = { reply_domains: ["reply.instapaytient.com"], reply_local_part: "assistant", from_name: "<existing SENDGRID_FROM_NAME>" }`, write the corresponding `EMAIL_REPLY_DOMAIN#reply.instapaytient.com` index record. Migration must happen BEFORE the deploy, not after, or every inbound `assistant@reply.instapaytient.com` email rejects with `rejected_unknown_account` until the records are written.
- **`EmailReplyInboundProcessOutcome` gained `"rejected_unknown_local_part"` as a new union variant.** A non-ULID, non-matching local-part (e.g., `garbage@reply.acmestore.com`) used to return `rejected_malformed`; it now returns `rejected_unknown_local_part` after the domain-then-local-part validation. Operationally inert (the controller returns 200 in both cases); consumers don't distinguish. Change is documented in the test suite.
- **Deprovisioning is GetItem-then-TransactWrite, not pure TransactWrite.** Removing a single element from a DDB List by value requires knowing the index, and DDB doesn't support filter-based array removal. The clean two-phase pattern (read account, locate index, write with the located index) creates a small non-atomicity window between the GetItem and the TransactWrite — if the array changes in between, the indexed REMOVE could remove the wrong element. Acceptable for v1 because deprovisioning is admin-only and low-frequency; future migration to DDB StringSet would make single-element removal atomic. JSDoc documents this.

**Next:**
- **User-side prerequisites BEFORE deploy:**
  1. For each existing production account that should receive email cold-entry: write the account record's `channels.email = { reply_domains, reply_local_part, from_name }` and write the `EMAIL_REPLY_DOMAIN#<domain>` index record. The existing `reply.instapaytient.com` account is the only one needing migration today.
  2. Remove the six dropped env vars from production secrets: `SENDGRID_REPLY_ACCOUNT_ID`, `SENDGRID_REPLY_DOMAIN`, `SENDGRID_FROM_EMAIL`, `SENDGRID_FROM_NAME`, `TWILIO_REPLY_ACCOUNT_ID`, `TWILIO_PHONE_NUMBER`. They have no consumers in the code anymore; leaving them set is harmless but cluttered.
  3. For each account that should receive SMS: provision a Twilio number (or the existing one), write the account record's `channels.sms.phone_numbers`, write the `TWILIO_NUMBER#<E.164>` index record. SMS now works for ANY account that's been provisioned this way.
- **Future caching layer (deferred):** if extreme scale eventually demands sub-10ms account routing, an app-level Redis cache or DAX in front of `ChannelAddressService.getAccountByChannelAddress` is purely additive — no data model change needed. The mapping is rarely invalidated; cache hit ratio would be ~99%+.
- **Pre-existing follow-ups still queued (deliberately deferred, not as cons — as a deliberate next phase):**
  - SendGrid webhook signature verification (Twilio got it for free; SendGrid doesn't have it today).
  - `collect_contact_info` E.164 normalization for LLM-passed phone numbers.
  - Coverage gap: no test for the `bad_pk` defensive guard branch in `getAccountByChannelAddress`. Worth adding in a future cleanup pass.
  - Per-account branding on tool-originated email sends (`send_email`, `request_verification_code`) — graceful degradation today; can become a future enhancement if customer feedback warrants.
- **Architecture diagrams** still on the deferred list per the user's May 3 request — proactively surfaceable after the next major piece ships. With multi-tenant channel routing now in place, the data model has changed substantially enough to warrant updating any diagrams when they're produced.

---

## 2026-05-06 — Trifecta achieved: Twilio SMS as third inbound channel (web + email + SMS)

**Goal:** Add SMS as a third inbound conversation channel via Twilio, parallel to the existing email channel. A visitor can text the deployment's Twilio phone number; the message routes to a chat session (cold entry, fresh continuation, or stale-session reset based on the sender's phone) and the agent's reply sends back via SMS. Phone becomes a parallel identity key on the customer record (mirroring email today via a new GSI2). The SMS stack is fully self-contained — its own webhook controller, reply service, transport service, and config service — exactly the way the email stack stands today.

The user's framing for this phase was decisive: build now / build later, not "approach A vs. B with cons." Code shape similarity between email and SMS is incidental, not duplication; each channel owns its own domain identity. No abstraction was extracted between the two stacks. When channel #4 lands (Slack, WhatsApp, etc.), it gets its own stack the same way.

**What changed:**
- 10 new files: `TwilioWebhookController` (signature verification + form parse + hand-off, returns 200 with no body in all paths), `SmsReplyService` (3-case routing — cold entry / fresh continuation / stale reset, MessageSid dedupe, phone stamp, agent dispatch, outbound reply), `SmsService` (thin Twilio SDK wrapper with one `send` method), `TwilioConfigService` (5 getters), `src/types/Sms.ts` and `src/types/SmsReply.ts`, plus 4 spec files.
- 7 modified files: `customer.service.ts` extended with `queryCustomerIdByPhone` mirroring `queryCustomerIdByEmail`, GSI2 keys written to the customer record when phone is non-null (sparse index — customers without phone aren't indexed); `GuestCartCustomerRecord` extended with optional `GSI2-PK?` / `GSI2-SK?`; `configuration.ts` + `env.schema.ts` extended with `twilio` block (5 keys + `webChat.phoneGsiName`); `main.ts` adds `app.use(express.urlencoded({ extended: true }))` so Twilio's form-encoded webhooks parse correctly; `app.module.ts` registers the 3 new providers + 1 controller.
- New GSI2 on the conversations table (must be provisioned before code goes live): `ACCOUNT#<accountUlid>` PK + `PHONE#<E.164>` SK, filtered on `entity = "CUSTOMER"`. Phone is stored in E.164 always.
- The May 5 email-path null-init lesson is mirrored exactly: `handleCase3StaleNewSession` writes METADATA with three SET clauses (`customer_id`, `continuation_from_session_id`, `_lastUpdated_`) and **deliberately does NOT include `continuation_loaded_at`** — that field stays absent so the continuation loader's `if_not_exists` write succeeds on first fire. Inverse assertions in the spec lock the behavior.
- Twilio webhook signature verification at the controller layer using the SDK's `validateRequest`, with the URL built from `TwilioConfigService.publicWebhookUrl` (NOT from `req.protocol + req.get('host')` — which would mismatch behind load balancers). Invalid/missing signatures return 200 with no body and skip routing entirely (Twilio's recommendation: don't reveal verification state to attackers). The `publicWebhookUrl` getter strips a trailing slash to prevent double-slash production failures.
- Phone PII never reaches the LLM. The controller stamps the sender's phone on `USER_CONTACT_INFO` via `if_not_exists` semantics at session creation; tools read `USER_CONTACT_INFO` from DDB when they need contact details. The phone never appears in agent `messages[]` content, system prompt, or any tool input/output schema. Log lines use `buildRedactedPhone` to elide the middle digits.
- Dedupe via Twilio MessageSid, stored as `SMS_INBOUND#<MessageSid>` PK with `attribute_not_exists(PK)` ConditionExpression. After routing decides the session, each case handler issues a small `UpdateCommand` to backfill the dedupe record's `sessionId` with `CHAT_SESSION#<ulid>` for operational traceability — flagged by reviewer as a SHOULD FIX, fixed in the close-out.
- Build clean. Test suite green: 635 / 41 suites / 0 failures (was 607 pre-phase, +28 from new spec files + new tests in `customer.service.spec.ts`). All 9 verification checks confirmed: `npm install twilio` succeeded, no email-stack imports in any new SMS file (zero matches), no `continuation_loaded_at` in `sms-reply.service.ts` source, `main.ts` URL-encoded body parsing in place before `app.listen`.

**Decisions worth remembering:**
- **Code shape similarity is not duplication when domain identity differs.** Email and SMS look structurally similar in their case handlers because the conversational lifecycle is the same. They are NOT the same domain — different transport (SendGrid vs. Twilio), different sender keys (email vs. phone), different webhook event shape, different SDKs. Extracting an abstract `ChannelInboundService` base class right now would be premature: two implementations don't validate an abstraction; three do. The decision is: ship parallel stacks now, refactor only when channel #4 forces the question.
- **The user's "no tradeoffs, only build now / build later" framing.** Mid-brainstorming, the orchestrator presented Approach 1 (parallel mirror) with cons listed, and the user pushed back hard: this project's guiding star is scalability + things done right; if something feels like a con, it means we did it wrong somewhere. Reframing as "what we build now (in scope) and what we explicitly defer (build later)" is the correct vocabulary. Saved as a feedback memory for future brainstorms.
- **SMS is treated as carrier-validated identity.** Mirroring email's `assistant@` cold-entry trust model: the carrier verifies the From: phone, so we trust it. No SMS verification flow, no `request_sms_verification_code` tool. If abuse signals show up in production, escalate to a verification flow then. For v1, the May 2 architectural rule still holds: code enforces invariants (`queryCustomerIdByPhone` is the deterministic gate for returning-visitor recognition), LLM drives intent (the agent decides what to say after the visitor is identified).
- **Defer reply-length tuning.** Twilio segments long replies at 160 chars (or 70 chars for non-GSM-7 chars). Multi-segment replies cost more and feel weird (4-6 buzzes for one agent reply). The user explicitly chose to ship as-is and observe real customer behavior before deciding to add a channel-aware prompt hint or server-side post-processor. Approach (b) channel-hint or (c) post-processor are both pre-considered and noted in the spec for a future phase.
- **`publicWebhookUrl` trailing slash strip is a real production hazard caught in code review.** If an operator configures `PUBLIC_WEBHOOK_URL=https://api.example.com/`, signature verification silently fails for every inbound message. The getter now does `.replace(/\/$/, "")`. One-line fix; would have caused a frustrating outage if shipped without it. Worth flagging the pattern: any config getter that participates in URL construction should normalize trailing slashes.
- **Phone-on-customer-record handoff via `USER_CONTACT_INFO`.** When a SMS-cold-entry visitor texts in, we have phone but not email at session creation. We can't create the customer record yet (customer needs email). The clean solution: SMS controller stamps phone on `USER_CONTACT_INFO` at session creation; later, when `collect_contact_info` collects the visitor's email + name, it reads `USER_CONTACT_INFO` (which already has phone), and creates the customer record with phone + email + GSI1 + GSI2. Zero changes needed to `collect_contact_info` — that tool already reads `USER_CONTACT_INFO` post-write before customer creation. Clean separation of concerns; phone PII flows through DDB, not through the LLM.
- **Brainstorming spec format `.claude/plans/<topic>.md` is the project's spec → sub-agent handoff pattern.** The earlier `discovery-service-refactor.md` was the format reference. Each major phase gets its own plan file. The user's standing 5-step sub-agent workflow (arch-planner → code-implementer → style-refactor → test-suite-runner → code-reviewer) runs against the plan as the source-of-truth spec.

**Next:**
- **User-side prerequisites before SMS goes live in production:** (a) provision GSI2 on the conversations table (`ACCOUNT#<accountUlid>` PK + `PHONE#<E.164>` SK, filter on `entity = "CUSTOMER"`, projection ALL); (b) configure the 5 Twilio env vars + `PUBLIC_WEBHOOK_URL` + `DYNAMODB_PHONE_GSI_NAME` in the production environment; (c) verify the Twilio number is provisioned and the inbound webhook URL is set to `https://<deployment>/webhooks/twilio/inbound`; (d) run a real end-to-end SMS test from a personal phone.
- **Future phases queued (deferred deliberately, not as cons):** SMS-aware reply length tuning (channel hint passed to the agent, ~20 lines of prompt diff); multi-tenant Twilio number → account mapping; proactive outbound SMS triggers (abandoned-cart text, checkout-link delivery); SMS verification flow if abuse signals show up.
- **Pre-existing gaps flagged but explicitly out of scope this phase:** SendGrid webhook signature verification doesn't exist (Twilio gets it for free here; SendGrid hardening is queued); `collect_contact_info` doesn't normalize LLM-passed phones to E.164; `SENDGRID_REPLY_ACCOUNT_ID` is missing from `env.schema.ts`. None block production, all worth a small follow-up phase when the time is right.

---

## 2026-05-05 — Returning-visitor cart-awareness (`check_active_cart` tool + post-verification prompt section)

**Goal:** Close the gap surfaced by the May 4 Playwright Phase 2 test — after a returning visitor verified, the agent acknowledged them ("Welcome back, Pat!") but then re-asked "Would you like me to add this to your cart?" even though the visitor's unpaid cart from Phase 1 already existed in DDB. Diagnosis: BOTH a tool gap (no structured "is there an active cart?" signal) AND a prompt gap (RETURNING VISITOR FLOW never instructed a check). Fix is a deterministic-signal tool plus an intent-routing prompt section, designed as a reusable pattern for every future agent with "unfinished business" semantics (financing, booking, subscription, etc.).

**What changed:**
- New read-only tool `check_active_cart` at `src/tools/check-active-cart.tool.ts` (~178 lines incl. types, schema, registration). Walks: current session METADATA → reads `customer_id` and `continuation_from_session_id` (strips `CHAT_SESSION#` prefix) → prior session METADATA → reads `cart_id` and `guest_id` (defensively normalizes legacy bare ULIDs to `C#`/`G#` prefixed shape) → cart record at `A#<account>` / `<G#guestUlid><C#cartUlid>`. Returns `{ has_cart: true, items, cart_total_cents, last_updated_at, was_link_generated_at: null }` on hit, `{ has_cart: false }` on every miss/error path. No throws escape; all 9 early-exit returns use `satisfies GuestCartCheckActiveCartResult` for compile-time shape guarantees. `was_link_generated_at` is forward-compatible (always null in v1; type ready for a future field).
- New `POST-VERIFICATION CART CHECK` section in `shopping_assistant.agent.ts` slotted between the `verify_code` `{ verified: true }` block and the `wrong_code` block. Tells the agent: immediately call `check_active_cart` after verification; if `has_cart: true`, name the items + format total as `$X.XX` and offer three explicit paths (resume → `generate_checkout_link`, modify → `preview_cart` with full updated list, abandon → continue normal flow); if `has_cart: false`, defer to the existing acknowledgment block with no cart mention. `check_active_cart` added to the agent's `allowedToolNames` (8th tool).
- 7 new spec tests in `check-active-cart.tool.spec.ts`: happy path with full outbound shape assertion, missing customer_id (no further DDB calls), missing continuation_from_session_id (no prior-session GetItem), prior METADATA missing cart fields (no cart GetItem), cart record missing, legacy bare ULID normalization (cart GetItem uses correctly prefixed SK even when prior METADATA had bare values), and missing accountUlid context (zero DDB calls fired). 3 new assertions in `shopping-assistant.agent.spec.ts` (allowlist length, `check_active_cart` containment, prompt section presence). Type changes: `GuestCartCheckActiveCartHit` / `Miss` / `Result` union appended to `GuestCart.ts` with the project's domain-prefix naming rule. Empty strict input schema (`checkActiveCartInputSchema`) appended to `tool.schema.ts`. Tool registered in `app.module.ts`.
- Reviewer-driven close-out: one log event name typo fixed (current-session METADATA miss path was logging `check_active_cart_prior_metadata_missing`, conflating it with the genuinely-prior-session miss paths — renamed to `check_active_cart_current_metadata_missing`). One bonus test added for the `accountUlid: undefined` early-exit path (asserts both outcome and zero `GetCommand` calls — the two-assertion pattern proves the guard exits before any DDB read, can't pass for the wrong reason). Style pass replaced two banned `as` casts on the new test with `satisfies ChatToolExecutionContext`.
- Build clean. Test suite green: 606 / 37 suites / 0 failures (was 597 pre-phase, +7 new tool tests + 2 new agent spec assertions).

**Decisions worth remembering:**
- **Tool + prompt is non-negotiable for trust-relevant outcomes.** Tool-only would still leave the agent unaware that calling it is the right move. Prompt-only would leave the LLM probabilistically reasoning over "is there a cart?" from prior-conversation hints — same defense-in-depth principle that drove the May 2 verification guard. Both layers in place, one deterministic, one routing intent. The pattern matches the architectural rule: "LLM drives intent, code enforces invariants."
- **The pattern is verbatim-reusable for future agents.** The prompt template ("After `verify_code` returns true, immediately call `check_active_<domain>`. If unfinished state exists, reference specifics and offer resume/modify/abandon paths") drops directly into financing (`check_active_prequal`), booking (`check_active_appointment`), subscription (`check_active_trial`) agents with no shared infrastructure — each domain owns its own check tool encapsulating its definition of "unfinished." A monolithic post-verification orchestrator would couple unrelated domains; per-domain tools were explicitly the right call.
- **Defensive normalization for legacy bare-ULID `cart_id`/`guest_id`.** Sessions created before the May 4 ID-prefix consistency pass have bare values for these fields; sessions after have prefixed values. The cart SK construction in `preview-cart.tool.ts:386-390` already encoded the right pattern (`hasBothIds` branch), and `check_active_cart` replicates it exactly. Test 6 explicitly exercises the bare-value path to lock the guard.
- **Forward-compatible `was_link_generated_at: null`.** No source-of-truth field exists today for "when was the checkout link last generated for this cart." Rather than add a new DDB field in this phase, the type was shipped as `string | null` and the implementation always returns null. A future enhancement (when the ecommerce side adds the timestamp or generate-checkout-link starts stamping it) gets a no-type-change rollout. Day-1 cost: zero. Day-N cost: one read.
- **`satisfies` on every early-exit return is a compile-time net.** All 9 `{ has_cart: false }` returns use `satisfies GuestCartCheckActiveCartResult`, meaning a future widening or narrowing of the union type can't silently miss a branch. The reviewer flagged this as a non-obvious good call worth keeping as a reference pattern for similar tools.
- **N-1 (prompt-ordering tension) deferred intentionally.** The reviewer flagged a minor reasoning burden: the existing "acknowledge warmly" bullet sits above the new POST-VERIFICATION CART CHECK section's "before saying anything else, immediately call check_active_cart" instruction. The `has_cart: false` path resolves the conflict (defers to the original block), but a reader has to hold both. Resolution = full prompt-restructuring pass to fold warmth into the `has_cart: false` branch only — out of scope here, queued as a future small phase.

**Next:**
- **Re-run Playwright Phase 2 with the new tool + prompt in place.** Returning visitor scenario: prior session has cart with Walk Adventure 30 min ($30) → verify → expect "Welcome back, [name]! I see you had a Walk Adventure 30 min ($30.00) in your cart from last time. Want to pick up where you left off and head to checkout, or did you want to make changes first?" The three-path framing should be preserved verbatim by Sonnet.
- **Prompt-restructuring pass (N-1).** Fold the "acknowledge warmly" bullet into the `has_cart: false` branch only. Eliminates the reasoning tension entirely. Small scope, ~20 line diff in shopping_assistant.agent.ts.
- **Pre-existing email-path null-init issue (`handleCase3StaleNewSession`)** — still queued as a small follow-up from May 3. Doesn't block anything.
- **Architecture diagrams** still on the deferred list (user request from May 3). Surface proactively after the next major piece ships.

---

## 2026-05-04 — DDB ID-prefix consistency pass (7 fields aligned with ecommerce-side conventions)

**Goal:** A live Playwright test on May 4 surfaced a real consistency issue: the customer record's `latest_session_id` field stored a bare ULID, while session METADATA's `customer_id` stored a prefixed `C#<ulid>`. The user noted that the e-commerce application that shares this DynamoDB table uses prefixed IDs everywhere — storing bare IDs in this API broke cross-application consistency and made debugging harder. This phase aligns 6 attribute values to prefixed form across CUSTOMER, SESSION METADATA, and CHAT_SESSION POINTER records, plus renames one field on EMAIL_INBOUND records (`sessionUlid` → `sessionId`) per the project's NEW-fields-use-`Id`-not-`Ulid` naming rule.

The user explicitly emphasized: "we need to get it right and not introduce bugs." After two prior phases where silent scope drift caused regressions, this work was scoped tightly with extensive risk-mitigation — defensive normalization at all read sites to handle both old (bare) and new (prefixed) records during transition, plus a dedicated regression test for each high-risk path.

**What changed:**
- 7 DynamoDB attribute changes (6 value-prefix, 1 field rename + value-prefix):
  1. `latest_session_id` on CUSTOMER record → `CHAT_SESSION#<ulid>`
  2. `account_id` on SESSION METADATA → `A#<ulid>`
  3. `continuation_from_session_id` on SESSION METADATA → `CHAT_SESSION#<ulid>` or null
  4. `cart_id` on SESSION METADATA → `C#<cartUlid>`
  5. `guest_id` on SESSION METADATA → `G#<guestUlid>`
  6. `session_id` on CHAT_SESSION POINTER → `CHAT_SESSION#<ulid>` (matches the SK exactly)
  7. EMAIL_INBOUND record: field renamed `sessionUlid` → `sessionId`, value prefixed → `CHAT_SESSION#<ulid>` or null
- 4 defensive normalization sites added to handle both old (bare) and new (prefixed) records during transition: `customer.service.ts` strips `CHAT_SESSION#` from `latest_session_id` so callers continue to receive bare ULIDs; `chat-session.service.ts:~93` strips `A#` from `account_id` so downstream tool context still receives bare ULID; `chat-session.service.ts:~243` uses `startsWith(CHAT_SESSION_PK_PREFIX)` guard before building `priorSessionPk` to prevent `CHAT_SESSION#CHAT_SESSION#<ulid>` double-prefix on prefixed records; `preview-cart.tool.ts` and `generate-checkout-link.tool.ts` strip `C#`/`G#` prefixes in payload returns, Slack alert args, and URL params (frontend expects bare ULIDs in checkout URL query strings).
- Cart SK construction (`preview-cart.tool.ts`) diverges by `hasBothIds` flag: when METADATA has both fields (already prefixed), SK is built by pure concatenation `${guestUlid}${cartUlid}`. When freshly minting (bare ULIDs from `ulid()`), SK is built with explicit prefixes `G#${guestUlid}C#${cartUlid}`. Both branches are clearly delineated and individually tested.
- `EmailReplyRecord` field rename: `sessionUlid: string | null` → `sessionId: string | null`. No defensive read needed — the field is write-and-forget audit only (no consumer reads it back). Hard cutover for this one field.
- 6 new regression tests added across 4 spec files: `customer.service.spec.ts` (prefixed-value normalization + legacy-bare passthrough), `chat-session.service.spec.ts` (`account_id` normalization + `continuation_from_session_id` double-prefix guard), `preview-cart.tool.spec.ts` (fresh-mint METADATA prefix write + cart SK shape regex), `generate-checkout-link.tool.spec.ts` (URL params strip prefixes).
- Style pass: replaced 2 nested ternaries in defensive normalization sites with `let` + `if` blocks for readability; removed 3 `as Record<string, string>` casts from new tests, replaced with optional chaining.
- Reviewer-driven cleanup pass: added cart SK shape regex assertion in fresh-mint test, added clarifying comment on `GATE_OPEN_METADATA` (legacy-bare-form fixture), extracted `CHAT_SESSION_PK_PREFIX` constant in `customer.service.ts` (was repeating the literal string twice).
- Build clean. Test suite green: 597 tests / 36 suites / 0 failures (was 591 pre-phase, +6 from new regression tests).

**Decisions worth remembering:**
- **Cross-application consistency is a stronger principle than minimal-diff.** The previous arch-planner pass recommended leaving 4 fields bare (compound-key parts and audit-only fields) on minimal-diff grounds. The user overrode this on cross-application-consistency grounds: the e-commerce app uses prefixed IDs everywhere, and this API not following the same convention created a real-world inconsistency that would compound over time. Ship the consistent shape now; defensive normalization handles the transition.
- **`hasBothIds` SK construction divergence is intentional and worth testing both branches.** When values flow from METADATA (already prefixed), use concatenation. When freshly minted (bare), use explicit prefix. Crossing the branches would silently produce malformed SKs that are unfindable. Both branches now have explicit test coverage.
- **Defensive read normalization is the right pattern for this kind of transition.** The alternative — strict cutover with no fallback — would have rendered every pre-fix dev session unreadable. Defensive code is ~3-5 lines per site and lifts cleanly when old records cycle out. TODO comments mark each site for eventual removal.
- **Field naming convention violations should be cleaned up when found, not deferred.** The `sessionUlid` field on EMAIL_INBOUND was a pre-existing inconsistency with the project's "NEW fields use `_id`/`Id`" rule. The wire-contract rename earlier shipped left this storage-side field unchanged. Catching it here as part of the broader prefix pass was efficient — same blast radius for a rename + a value change.
- **Three sleeper bugs prevented by tight reviews.** (1) The arch-planner caught the double-prefix risk on `chat-session.service.ts:~243` — without the `startsWith` guard the loader would silently fail. (2) The reviewer caught that the `!hasBothIds` branch SK was exercised but not directly asserted against the expected shape — added an explicit regex assertion. (3) The implementer caught that the strict Crockford regex `[0-9A-HJKMNP-TV-Z]{26}` would reject the existing test fixture ULIDs (which contain `I`/`L`/`U` from pre-existing constants out of scope), pragmatically using `[0-9A-Z]{26}` instead since structural shape is the test's job (Crockford byte validity is the ulid library's).
- **Test fixture Crockford-invalid constants flagged for future cleanup.** Several pre-existing fixture constants like `01PRIORSESSION00000000000` contain Crockford-excluded characters and/or are wrong length. They were left alone in this phase per the user's "don't refactor existing names" rule but will need a future small cleanup pass.

**Next:**
- **Re-test the full flow with the new prefix shapes in production.** Phase 1 (new visitor) should produce a checkout URL with bare ULIDs in query params (frontend-facing strip works). Phase 2 (returning visitor) should still verify cleanly via `verify_code` (defensive guards handle the prefixed values transparently). The DDB records can be inspected directly to confirm the new shapes (`A#<ulid>`, `C#<ulid>`, `G#<ulid>`, `CHAT_SESSION#<ulid>`).
- **Issue 2 (cart awareness on return) still queued for future discussion.** From the May 4 Playwright test: after verification, the agent re-asked "would you like me to add this to your cart" instead of recognizing the unpaid cart from Phase 1. This is a separate UX issue — the prior-history loader fired but didn't surface the cart state for the agent to reason about. Worth scoping as a future phase: prompt + possibly tool work to expose returning-customer cart state cleanly.
- **Email-path follow-up (handleCase3StaleNewSession null-init recreation)** — flagged by the reviewer of the May 3 customer_id fix as a pre-existing CCI Phase 3 issue. The current phase didn't touch it. Still queued as a small follow-up.
- **Architecture diagrams** still on the deferred list per the user's request from May 3. Surface proactively after the next major piece ships.

---

## 2026-05-03 — Fix customer_id null-init bug (downstream `if_not_exists` writes were silently no-op'ing)

**Goal:** Live Playwright test on May 3 surfaced a real production bug. After a clean shopping_assistant end-to-end checkout flow, the session METADATA had `customer_id: null` despite `[event=customer_created]` having fired in the logs. Downstream effect: checkout URL contained `customerId=null`, breaking Stripe metadata propagation and AI-conversion Slack notifications. Diagnostic chain pointed at the foundation-era pattern of pre-initializing METADATA fields to null on session creation.

**Root cause (verified field-by-field):**
DynamoDB's `if_not_exists(path, value)` returns the existing value at `path` if the attribute exists, OR `value` if not. **Critically, an attribute with value NULL counts as "exists" in DynamoDB** — `attribute_exists()` returns true for null-valued attributes. `SessionService.lookupOrCreateSession` was initializing three fields (`customer_id`, `continuation_from_session_id`, `continuation_loaded_at`) to null on session creation via `if_not_exists`. After session creation, all three attributes EXISTED on METADATA with value NULL. Then `collect_contact_info` Step 6's `if_not_exists(customer_id, :real_id)` write saw the attribute as existing and short-circuited — write became a silent no-op, customer_id stayed null forever. Bug had been present since the foundation phase but went unnoticed because every prior test path went through `verify_code` for verification, and `verify_code` writes `customer_id` via plain SET (not if_not_exists), bypassing the broken guard. The May 2 verification guard fix correctly skipped verification for new visitors with shopping_assistant — exposing the broken collect_contact_info write path.

**What changed:**
- `SessionService.lookupOrCreateSession` Branch B no longer pre-initializes `customer_id`, `continuation_from_session_id`, or `continuation_loaded_at`. The 3 setClauses + 3 corresponding ExpressionAttributeValues entries (`:customerIdNull`, `:contFromNull`, `:contAtNull`) removed. All other setClauses (`_createdAt_`, `_lastUpdated_`, `source`, `agent_name`, conditional `account_id`) preserved exactly. Branch A (resume) and pointer record write unchanged.
- `ChatSessionMetadataRecord` type updated: the three fields changed from required `string | null` to optional `?: string | null` (accurately reflects the new "absent on creation" semantics). Inline comments updated. All consumers already used `?? null` patterns, so no cascading breaks.
- One test in `session.service.spec.ts` rewritten with INVERSE assertions: explicitly asserts the 3 fields are NOT in `ExpressionAttributeValues` and NOT in `UpdateExpression`. Locks the new behavior — any future regression that re-adds the null-init fails this test immediately.
- New regression test in `collect-contact-info.tool.spec.ts` describe block 15: METADATA has no `customer_id` attribute (post-fix fresh-session state) → tool fires Step 6 UpdateCommand with `:customer_id = "C#<ulid>"`. This test would have caught the bug at the time it was introduced.
- Style pass removed one banned `as Record<string, string>` cast from the new test, replaced with optional chaining (`call.args[0].input.Key?.SK === "METADATA"`). Pre-existing instances of the same pattern in describe blocks 4, 9, 11 left alone (out of scope, future nit).
- Build clean. Test suite green: 591 tests / 36 suites / 0 failures (was 590 pre-phase, +1 from the new regression test).

**Decisions worth remembering:**
- **DynamoDB `if_not_exists` treats null as "exists."** This is the third time we've been bitten by a subtle DDB semantic in this codebase (Crockford ULID validation was the first; eventually-consistent reads on a fresh PK was a near-miss). Worth internalizing: `if_not_exists(field, value)` is genuinely "if attribute is absent, write value; otherwise leave it alone" — and "absent" specifically means the attribute key is not present on the item, NOT that its value is null. If you want write-through behavior on null, use plain SET; if you want guard-against-overwrite behavior, ensure the attribute is NEVER pre-initialized.
- **Don't pre-initialize fields you intend to guard with `if_not_exists` later.** The original null-init was likely intended as read-side safety (so consumers can rely on the field being present), but read-side `?? null` patterns made that unnecessary, AND the init poisoned the write-side guards. The cleaner pattern: leave fields absent until something needs to set them; consumers handle absence via `?? null`. Apply this principle to any future METADATA field that has both a "default null" desire AND a downstream `if_not_exists` writer.
- **Bonus correctness win:** `continuation_loaded_at`'s `if_not_exists` write in `chat-session.service.ts:322` was broken the same way. Same root cause, same line removal repaired both. For web sessions where `verify_code` sets `continuation_from_session_id`, the prior-history loader will now correctly stamp `continuation_loaded_at` on its first fire instead of silently no-op'ing.
- **Pre-existing email-path issue flagged.** Reviewer noted that `email-reply.service.ts:506-514` (`handleCase3StaleNewSession`) explicitly writes `continuation_loaded_at: null` via plain SET immediately after session creation, recreating the same DDB pattern for the email path only. This is a CCI Phase 3 pre-existing issue, NOT introduced by this fix, but worth a future small follow-up phase. Tracked in the journal here so it doesn't get lost.
- **Existing dev sessions with stale `customer_id: null`.** Pre-production. New sessions get the correct write-through behavior. Sessions created during the bug window stay null forever (the if_not_exists guard will keep returning null on re-runs of collect_contact_info). No migration needed — acceptable.

**Next:**
- **Re-run Playwright with shopping_assistant returning-visitor flow.** This is the test the user deferred until the customer_id fix landed. Should now exercise: first session establishes the customer record (customer_id correctly written this time); fresh-localStorage second session with same email → agent recognizes via `isReturningVisitor: true` from collect_contact_info → calls `request_verification_code` → guard reads METADATA's customer_id (real C# value), reads customer record, compares timestamps (customer was created in a prior session → guard ALLOWS) → email sent → code arrives → verification completes → prior-history loader fires.
- **Email-path follow-up.** The pre-existing `handleCase3StaleNewSession` null-init issue is small, well-scoped, and worth grabbing as a small phase before the next major piece of work.
- **Architecture diagrams** still on the deferred list per the user's request from May 3. Surface proactively after the next major piece ships.

---

## 2026-05-03 — Restructure SessionService back to atomic `lookupOrCreateSession` (fixes Phase 2 agent_name regression)

**Goal:** Fix two regressions Phase 2 (commit `2425bb17`) silently introduced when the IDENTITY pattern was removed. The OLD `IdentityService.lookupOrCreateSession` was one atomic service method that wrote `agent_name = if_not_exists(agent_name, :agentName)` to METADATA AND wrote `agent_name: defaultAgentName` to the pointer record. Phase 2 split that method into a thinner `SessionService.createSession(source, accountUlid?)` (no agentName parameter) and moved the lookup-or-mint policy into `WebChatController`. In doing so, the agent_name write to METADATA was dropped entirely, and the pointer record's `agent_name` was hardcoded to `LEAD_CAPTURE_AGENT_NAME`. Result: every web session's METADATA had no `agent_name`. `chat-session.service.ts:91-92` falls back to `DEFAULT_AGENT_NAME = "lead_capture"` when `agent_name` is missing — so every web session was silently routed to lead_capture regardless of what the frontend requested. The user's `shopping_assistant` flow (budget → contact → services → checkout) was gone, replaced by `lead_capture`'s generic "Hello! Welcome." opener. Live Playwright testing surfaced the symptom; field-by-field diff against the OLD `lookupOrCreateSession` source identified the root cause.

**What changed:**
- Restructured `SessionService` so it has a single atomic `lookupOrCreateSession(source, sessionId | null, agentName, accountUlid?)` method that handles BOTH the resume path AND the create path. Same shape as the OLD `IdentityService.lookupOrCreateSession`, MINUS only the IDENTITY record write (Phase 2's actual win preserved).
- Branch A (resume): if `sessionId` is provided AND METADATA exists, returns `{ sessionUlid: sessionId, onboardingCompletedAt, kickoffCompletedAt, budgetCents, wasCreated: false }`. Branch B (mint): mints a fresh ULID, writes METADATA via UpdateCommand with all 7 setClauses (including `agent_name = if_not_exists(...)`), writes pointer record with `agent_name: agentName` (parameterized, NOT hardcoded). If `sessionId` is provided but METADATA missing, falls through to Branch B (silent stale-session replacement).
- Lookup-or-mint policy moved OUT of `WebChatController` and BACK INTO `SessionService`. The controller is genuinely thin again — no `DynamoDBDocumentClient` injection, no `DatabaseConfigService` injection, no `DYNAMO_DB_CLIENT` import, no `GetCommand` import, no `CHAT_SESSION_PK_PREFIX` / `METADATA_SK` constants. The `createSession` HTTP handler is back to: validate agent → verify account → call service once → fire slack alert if `wasCreated` → build response → return. Honors CLAUDE.md's "controllers are thin" rule.
- Email-inbound's 2 call sites (`handleCase2NewSession`, `handleCase3StaleNewSession` in `email-reply.service.ts`) updated to the new 4-arg signature: `("email", null, "lead_capture", accountId)`. Email always mints fresh (passes `null` for sessionId) and the agentName is now explicit (was implicit fallback before). Both use dot-notation `sessionResult.sessionUlid` per user preference (no destructuring).
- New `ChatSessionLookupOrCreateResult` type added to `src/types/ChatSession.ts`. Mirrors the OLD `LookupOrCreateSessionResult` shape exactly: `{ sessionUlid, onboardingCompletedAt, kickoffCompletedAt, budgetCents, wasCreated }`. Internal field name stays `sessionUlid` (NOT renamed to sessionId) per the user's standing internal-naming-convention rule.
- `LEAD_CAPTURE_AGENT_NAME` constant deleted from `session.service.ts` (no longer hardcoded — agentName flows through as parameter).
- 4 lookup-or-mint policy tests moved from `web-chat.controller.spec.ts` → `session.service.spec.ts` (their natural home now that the policy lives in the service). Controller spec slimmed to only test request validation, slack-alert gating, and response-shape building. New resume-path test in controller spec asserts slack alert NOT fired on `wasCreated: false`.
- 3 new Branch A tests in service spec: (a) sessionId provided + METADATA exists → resume with no UpdateCommand/PutCommand calls; (b) sessionId provided + METADATA missing → mint with new ULID; (c) sessionId null → mint immediately with no GetCommand call. New tests also assert `agent_name` flows into METADATA setClause AND pointer record using `"shopping_assistant"` (not lead_capture) as the test value — proves parameterization, NOT hardcoding. These tests would have caught Phase 2's regression at the time it was introduced.
- Style pass caught: `: unknown` annotation on a catch clause for codebase consistency, and 5 Crockford-invalid test fixture constants (`VALID_ACCOUNT_ULID` in session spec; `ACCOUNT_ID`, `CUSTOMER_ULID`, `PRIOR_SESSION_ULID`, `NEW_SESSION_ULID` in email-reply spec) replaced with valid 26-char Crockford strings. One pre-existing invalid constant in the `updateOnboarding` describe block left untouched (correctly out of scope).
- Build clean. Test suite green: 590 tests / 36 suites / 0 failures (unchanged baseline; deleted controller policy tests offset by new service spec tests).

**Decisions worth remembering:**
- **Atomic single-service-method beats split policy/writes.** Phase 2's split design (controller does policy, service does writes) made the system harder to reason about AND created a regression opportunity that promptly fired (agent_name dropped silently). The OLD IDENTITY-era shape (one service method that owned the entire flow) was clearer because session creation was atomic in one place. After much deliberation with the user, the conclusion: removing the IDENTITY record was right; splitting the implementation was wrong. This phase restores the atomic shape.
- **`agentName` is a REQUIRED parameter (not optional).** TypeScript will fail to compile if any caller forgets it. This makes future regressions of this exact shape structurally impossible. If someone deletes the agent_name setClause but leaves the parameter, the new test would fail. If someone removes the parameter entirely, every call site breaks at compile time.
- **Both regressions are independently asserted in tests.** The METADATA setClause test uses `"shopping_assistant"` (not the default lead_capture) to prove the value flows through the parameter. The pointer record test asserts the same. A future implementer dropping either would fail a test immediately. This is the pattern: when fixing a regression, write the test that would have caught it at the time it was introduced.
- **The user's instinct on architectural sophistication is real.** This codebase has gotten complex enough that even careful arch-planner-driven work missed the agent_name field flow during Phase 2. The user requested architecture diagrams to add as a follow-up — saved as a memory for proactive surfacing after the next major piece ships.
- **Pre-fix dev DynamoDB sessions still work.** Sessions created during the regression window (between Phase 2 commit on May 2 and this fix on May 3) have METADATA without `agent_name`. The existing fallback at `chat-session.service.ts:91-92` (`rawAgentName || DEFAULT_AGENT_NAME`) handles this gracefully — those sessions effectively use lead_capture forever. New sessions get correct `agent_name` written. For pre-production, no migration needed.
- **Customer_id null mystery deferred.** The same Playwright run that surfaced the agent regression also showed `customer_id` was null on METADATA at verification-guard read time, even after `[event=customer_created]` had fired. Could be a side effect of the lead_capture agent (wrong agent) calling the tool path differently than shopping_assistant would. Deferred to post-restructure investigation — retest with shopping_assistant in control first; if customer_id still goes null, separate bug to chase.

**Next:**
- **Re-test the full happy path with shopping_assistant routing intact.** Should see the budget → contact → services → checkout flow restored. The Affirm/financing opener should be back. If anything else surprising surfaces, it's its own bug.
- **Verify the customer_id-null mystery resolves.** Probably resolves naturally with the correct agent in control. If not, separate investigation phase — start by adding a debug log in collect_contact_info Step 6 to confirm whether it's actually executing.
- **Architecture diagrams** — flagged as a future proactive offer when the next major piece ships. User's request, saved as memory.
- The pre-existing Crockford-invalid `SESSION_ULID` constant in the `updateOnboarding` describe block (`session.service.spec.ts:193`) is a future cleanup nit. Not blocking.

---

## 2026-05-02 — Verification-code guard: code enforces the invariant the LLM was hallucinating

**Goal:** Live Playwright testing surfaced a real bug. On a fresh DB with a brand-new visitor providing contact info one field at a time, Sonnet 4.6 (lead_capture agent) was occasionally hallucinating "Welcome back, [name]!" and calling `request_verification_code` even though `collect_contact_info` had correctly returned `customerFound: false`. The tool returned the right signal; the LLM ignored it. This phase closes the gap with defense-in-depth — a code-level guard at the tool boundary that makes the security violation deterministically impossible, plus prompt tightening to make the LLM less likely to even try the wrong call.

**What changed:**
- New code-level guard inside `request_verification_code` (between rate-limit check and code generation): reads the session METADATA's `customer_id` and `_createdAt_`, then reads the customer record's `_createdAt_`. If `customer._createdAt_ >= session._createdAt_` — meaning the customer was created during or after this session, i.e., a brand-new visitor — the tool refuses with `{ sent: false, reason: "no_existing_customer_to_verify" }`. No email, no DDB write, no side effects. Even a fully-rogue LLM cannot route around this.
- Edge cases handled by the guard: missing `customer_id` on METADATA → refuse; missing customer record entirely → refuse; missing `_createdAt_` on the customer record (legacy pre-CCI data) → treated as "cannot prove pre-existence" → refuse. Conservative-default safer.
- Refusal events are logged at warn level (NOT debug — these are significant behavioral signals worth seeing in production traces): `[event=verification_request_blocked_no_customer_id sessionUlid=...]`, `[event=verification_request_blocked_customer_missing sessionUlid=... customerId=...]`, `[event=verification_request_blocked_new_customer sessionUlid=... customerCreatedAt=... sessionCreatedAt=...]`.
- `collect_contact_info` field rename: `customerFound` → `isReturningVisitor`. Field is ONLY emitted when value is `true`. New customers now get just `{ saved: true }` with no suggestive field at all — removes the LLM's tendency to over-pattern-match on "customerFound" appearing in the result. `CollectContactInfoTrioCompletedResult` type eliminated; the simpler `CollectContactInfoSavedResult = { saved: true; isReturningVisitor?: true }` covers both branches.
- New `{ sent: false; reason: "no_existing_customer_to_verify" }` arm added to `VerificationRequestCodeResult`.
- Prompt tightening on BOTH agents that use the verification flow (`lead_capture.agent.ts` AND `shopping_assistant.agent.ts` — the planner missed the second; implementer correctly extended scope): added a new NEW VISITOR FLOW section directly before RETURNING VISITOR FLOW, establishing the default new-visitor path as primary and the returning-visitor path as the marked exception. Updated RETURNING VISITOR FLOW trigger to require `isReturningVisitor: true` explicitly. Added a Tool refusal guard block instructing the agent to drop the welcome-back framing immediately and continue normal flow if it ever receives `{ sent: false, reason: "no_existing_customer_to_verify" }` from the tool — graceful UX recovery for the rare residual hallucination edge.
- 3 new guard tests added to `request-verification-code.tool.spec.ts`: customer_id null on METADATA → refuse; customer `_createdAt_` after session `_createdAt_` → refuse; customer `_createdAt_` before session `_createdAt_` → allow. Existing happy-path tests updated with the 2 new GetCommand mocks. New `makeMetadataItem` / `makeCustomerItem` fixtures added.
- `collect-contact-info.tool.spec.ts` assertion updates for the renamed/suppressed field. Style pass replaced 11 `expect("customerFound" in parsed).toBe(false)` patterns with `expect(parsed.customerFound).toBeUndefined()` because the `in` keyword is banned in this codebase.
- Reviewer caught one real test-integrity issue: Test 5 (email-send-failure path) was passing for the wrong reason after the guard was added — its missing METADATA mock caused a TypeError that hit the catch block and returned the same shape the test asserted, so the test passed but never actually exercised the email-send-failure path. Fix: added the 2 missing GetCommand mocks + an `expect(mockEmailService.send).toHaveBeenCalledTimes(1)` assertion to explicitly prove the rejection fires.
- Build clean. Test suite green: 590 tests / 36 suites / 0 failures (was 587 pre-phase, +3 new guard tests).

**Decisions worth remembering:**
- **Tools enforce their own preconditions in code, never trust the LLM alone.** This is the architectural principle the user articulated verbatim during the design discussion: "The LLM should drive intent. The code should enforce invariants." For sensitive or security-relevant tools (verification, payment, irreversible writes), a prompt fix alone is probabilistic and not enough — even a perfect prompt has some non-zero hallucination rate, and "rare" is not acceptable for trust-violating outcomes. The same defense-in-depth pattern already used for tool allowlists (filtered list AND re-check at dispatch) applies here. Saved as a feedback memory for future tool work.
- **Rename suggestive field names; don't return them when "false."** `customerFound: false` was confusing the LLM — it was over-pattern-matching on the word "customerFound" appearing in the response and routing into RETURNING VISITOR FLOW even when the boolean was false. Renaming to `isReturningVisitor` AND only emitting when truthy gives the LLM a clear unambiguous signal: the field is present iff the visitor is returning. Negative space is silence.
- **Guard ordering inside the tool:** existing email check (`no_email_in_session`) and rate-limit check fire BEFORE the new guard. The guard's two new GetCommands are paid only when the prior cheap checks pass. Preserves existing early-exit semantics; minimizes DDB cost on already-rejected requests.
- **Timestamp comparison uses `>=` (customer at or after session start = new).** The edge case where customer and session timestamps are exactly the same millisecond (effectively impossible in practice given the tool-call sequence) is treated as "new" — safer default. Real returning customers' records were created in prior sessions hours-to-days earlier, so this comparison cannot produce a false positive in normal operation.
- **Both agents updated, not just the one with the bug report.** `shopping_assistant` had the same stale `customerFound: true` reference in its prompt. Fixing only the agent that surfaced the bug would have left a half-patched state. Implementer correctly extended scope; reviewer praised the call.
- **Prompt updates accept ~99% UX consistency, not 100%.** The code guard makes the email-send violation deterministically impossible. The prompt fix substantially reduces but doesn't eliminate the rare LLM-text-hallucination edge ("Welcome back" emitted before the tool refusal returns). User accepted this trade-off for v1; would consider heavier interventions (response post-processor, structured pre-step classifier) only if production traffic shows the rare residual edge persisting.
- **Three sleeper Crockford bugs caught across recent phases.** This phase: implementer used a valid 26-char Crockford ULID for the new `CUSTOMER_ULID` test fixture (`01ARZ3NDEKTSV4RRFFQ69G5FAV`), avoiding the class of bug caught in earlier phases where hand-typed ULIDs contained forbidden `I`/`L`/`O`/`U` characters. The lesson is clear: always verify test ULIDs are real Crockford strings, not "looks-like-a-ULID" placeholders.

**Next:**
- Bug fix shipped backend-side. Live Playwright re-test recommended to confirm the rare welcome-back text edge has been substantially reduced. If it persists at all in production traffic, escalate to heavier intervention (response post-processor or structured pre-step classifier).
- The Tool refusal guard pattern in `request_verification_code` is the template for any future sensitive tool. When designing a new tool whose effects are customer-trust-adjacent or irreversible, the tool itself should read its preconditions from DDB and return a structured refusal — never trust prompt instructions alone.
- One pre-existing nit flagged by the reviewer (one of the new guard log messages doesn't follow the `[event=...]` format the others use) — left as-is because it matches a pre-existing inconsistency in the file and is not a phase-2 regression. Worth a future cleanup pass if anyone touches the file.

---

## 2026-04-30 — Identity cleanup Phase 2: IDENTITY pattern removed (Option B)

**Goal:** Remove the IDENTITY translation table entirely. With Discord gone (Phase 1), web was the only remaining consumer of `IdentityService.lookupOrCreateSession`, and the indirection layer it provided (browser-side `guestUlid` → server-side `sessionUlid`) was no longer earning its keep — the frontend already used `sessionUlid` for every other call. Phase 2 finishes the cleanup the handoff doc flagged as Option B: the frontend stores `sessionId` directly in localStorage, the backend looks up sessions directly by their ULID, and the IDENTITY layer disappears completely.

**What changed:**
- Deleted `src/services/identity.service.ts` and `src/services/identity.service.spec.ts`.
- Created `src/services/session.service.ts` (renamed `IdentityService` → `SessionService`). Method `createSessionWithoutIdentity` was renamed to `createSession`; method `updateOnboarding` preserved verbatim. Method `lookupOrCreateSession` and the IDENTITY-record write path are gone. Race-recovery code (`isConditionalCheckFailed` helper, `ConditionalCheckFailedException` recovery branch) removed — the new flow has no shared key, so no race is possible.
- Created `src/services/session.service.spec.ts` with 10 tests: `createSession` (METADATA write, pointer write, no-account branch, pointer-failure resilience, return value) plus the existing `updateOnboarding` tests ported.
- Lookup-or-mint policy moved into the controller (`web-chat.controller.ts`): if the request body has a `sessionId`, GetItem on `CHAT_SESSION#<sessionId> / METADATA`; if found, return the existing session state; if not, mint a new one via `SessionService.createSession`. If `sessionId` is absent, mint directly. Slack alert fires only on the mint paths.
- Wire-contract rename (Option B): `sessionUlid` → `sessionId` everywhere on the public API. `WebChatCreateSessionRequest` drops `guestUlid` and adds optional `sessionId`. `sendMessageSchema` body field, the path-param schema (`sessionUlidParamSchema` → `sessionIdParamSchema`), `@Param("sessionId")` decorators, route paths (`sessions/:sessionId/messages`, `sessions/:sessionId/onboarding`), and all response bodies (`WebChatCreateSessionResponse.sessionId`, `WebChatOnboardingResponse.sessionId`) all updated. Internal TS variable names (`sessionUlid` in service params, logger interpolation keys, test fixture constants like `VALID_ACCOUNT_ULID`) deliberately left as-is per the standing scope-discipline rule.
- Email-inbound coupling: 2 call sites in `email-reply.service.ts` flipped from `identityService.createSessionWithoutIdentity` to `sessionService.createSession` (identical signature, just renamed). `email-reply.service.spec.ts` mock provider token updated. `app.module.ts` provider swapped.
- Types: `ChatSessionIdentityRecord` and `LookupOrCreateSessionResult` deleted from `src/types/ChatSession.ts`. Added `ChatSessionUpdateOnboardingResult` (extracted from the inline return type on `updateOnboarding`, per the no-inline-types rule).
- Style pass caught: domain-prefix rename of one type, inline-return-type extraction, and `as const` → `satisfies WebChatHistoryMessage[]` in the controller spec.
- Reviewer-driven cleanup: deleted an unused `ChatSessionCreateSessionResult` type that the implementer left in `ChatSession.ts` but no consumer ever imported; replaced "identity" with "session" in `docs/reference/concepts.md:66` (stale IDENTITY-era wording); replaced 3 malformed `accountUlid` and 6 malformed `sessionId` sample values in `docs/identity-cleanup/phase-2-frontend-contract.md` with valid 26-char Crockford ULIDs (the originals contained `I`/`L`/`O`/`U` and/or had wrong character counts).
- Docs updated: `docs/reference/architecture.md` (rewrote layered diagram, request lifecycle step 2, "what lives where", key design decisions), `docs/reference/concepts.md` (deleted entire Identity section, rewrote Channel and Session sections, removed source-name-convention IDENTITY entry), `docs/reference/data-model.md` (deleted IDENTITY record section, updated access-patterns table, updated "Written initially by" attribution), `docs/agent/engineering/creating-agents-and-tools.md` (step 1 of "How they work together"). The two pre-existing nits flagged by the Phase 1 reviewer (`data-model.md` line 24 `sessionUlid` → `session_id`, `architecture.md` lifecycle paragraph mentioning email's `createSessionWithoutIdentity`) were folded into this phase's doc pass.
- Created `docs/identity-cleanup/phase-2-frontend-contract.md` — the spec the widget repo will implement against. localStorage key (`instapaytient_chat_session_id`), full request/response shapes for every web-chat endpoint, behavior matrix for stored-sessionId-resolves vs unresolvable vs absent vs malformed.
- Build clean. Test suite green: 587 tests / 36 suites / 0 failures (down from 601 — the −14 delta is legitimate consolidation, validated by the reviewer; all 5 controller endpoints, 4 lookup-or-mint policy cases, slack-alert behavior, account verification, schema rejection, and delegation paths are all covered in the rewritten controller spec).

**Decisions worth remembering:**
- **Lookup-or-mint policy lives in the controller, not in `SessionService`.** It's policy (when to look up vs. create), not a DynamoDB operation. The service still owns all writes; the controller just decides whether to read first. Two round-trips on the resume path (GetItem then maybe createSession), one on the cold path. Acceptable.
- **Race recovery is gone, not replaced.** The old `lookupOrCreateSession` had race recovery because two concurrent requests with the same `guestUlid` could collide on `IDENTITY#web#<guestUlid>`. The new flow mints a fresh ULID on every cold call — there is no shared key. Two concurrent "new visitor" requests each get their own session. No retry, no conditional check, no helper. Confirmed safe by the reviewer.
- **Internal naming preserved per scope discipline.** The user explicitly limited the rename to the wire contract surface (HTTP body fields, path params, response fields) and the types/schemas that directly define them. Internal TS variable names (test constants like `VALID_ACCOUNT_ULID`, local vars holding destructured values, logger interpolation keys, the `sessionUlidForLog` parameter on `EmailReplyRecord`) deliberately stay as-is. Future passes can clean those up if/when desired; not in scope here.
- **Frontend contract is the deliverable for the separate widget repo.** This backend session ships behind a coordinated frontend deploy. `docs/identity-cleanup/phase-2-frontend-contract.md` is the hand-off spec — localStorage key, request/response shapes, behavior matrix. Widget engineer reads that, updates 4 call sites (create-session body field, sendMessage body field, two path params), one coordinated deploy.
- **Pre-production = clean cutover, no soft-transition fallback.** No production user data exists; no migration script; no backend dual-acceptance code. Existing dev DynamoDB records (`IDENTITY#discord#…`, `IDENTITY#web#…`) are left orphaned — harmless, cheap, no cleanup script.
- **Three Crockford-base32 sleeper bugs caught during the phase.** (1) Implementer caught the existing `VALID_ACCOUNT_ULID` test fixture had `I`/`L`/`U` and would have failed the new schema's regex once the test ever exercised it. (2) Reviewer caught 3 malformed `accountUlid` and 6 malformed `sessionId` samples in the frontend-contract doc — would have given a frontend engineer 400s on copy-paste. (3) Cleanup-implementer caught that the reviewer's suggested replacement ULID was 27 chars, not 26, and trimmed it before substitution. Each catch was a separate sub-agent — solid layering.

**Next:**
- **Identity cleanup is COMPLETE.** Phase 1 (Discord removal) shipped at `17c1b066`. Phase 2 (this commit) ships the IDENTITY pattern removal. The handoff under `docs/identity-cleanup/HANDOFF.md` is fully delivered.
- **Frontend repo follow-up (separate session):** widget engineer reads `docs/identity-cleanup/phase-2-frontend-contract.md`, makes the 4 wire-contract updates, deploys after the backend is live.
- **Optional future cleanup (not blocking):** the deferred test-fixture Crockford bugs in other spec files (`session.service.spec.ts`, several tool specs reuse `01ACCOUNTULID00000000000000` which is malformed). Could be folded into a "test-fixture-modernization" pass alongside any other dev-quality wins. The 4 pre-existing data-model.md nits the reviewer flagged (`agentName` snake-case mismatch, missing CCI fields in the METADATA table, `sessionUlid` on the EMAIL_INBOUND record table, `sessionUlid` mention in `concepts.md:85`) are all internal-naming-convention items the user has explicitly deferred.

---

## 2026-04-30 — Identity cleanup Phase 1: Discord channel removed

**Goal:** Remove the Discord channel adapter and all of its code, config, dependencies, tests, and docs. Discord was originally a cheap test harness for the chat backend — never part of the production product. Removing it leaves web as the only remaining IDENTITY-pattern consumer, which is the unblocker for Phase 2 (the IDENTITY pattern simplification flagged in `docs/identity-cleanup/HANDOFF.md`).

**What changed:**
- Deleted source: `src/services/discord.service.ts`, `src/services/discord-config.service.ts`, `src/types/Discord.ts`. No Discord controller or module file existed — the service was flat-registered in `AppModule` and listened via `OnModuleInit` on the discord.js gateway.
- Deleted reference doc: `docs/reference/channels/discord.md`.
- Edited config: `src/app.module.ts` (dropped two providers + imports), `src/config/configuration.ts` (dropped `discord:` block), `src/config/env.schema.ts` (dropped `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID`).
- Edited dependencies: `package.json` no longer declares `discord.js`; `package-lock.json` regenerated via `npm install`.
- Edited spec: `src/services/identity.service.spec.ts` source-string args swapped from `"discord"` to `"web"` and matching `IDENTITY#discord#…` PK fixtures swapped to `IDENTITY#web#…` (web is the only surviving consumer of `lookupOrCreateSession`, so the fixtures now reflect real production behavior). Three missing-space-after-colon nits caught by the style pass.
- Edited live reference docs: `docs/reference/architecture.md` (diagram, request lifecycle, "what lives where"), `docs/reference/concepts.md` (identity source table, channels list, source name convention), `docs/reference/data-model.md` (example source value), `docs/reference/channels/email.md` (cross-reference rewrite), `docs/reference/operations.md` (Discord env var section removed, runtime topology paragraph corrected). One approved deviation from the original plan: `operations.md` was not in the planner's scope but had to be edited because it documented env vars that no longer existed in the schema — leaving it would have actively misled operators.
- Edited entry-point docs: `docs/README.md` (dead link to deleted `discord.md` removed, opening prose rewritten without scar), `docs/agent/engineering/creating-agents-and-tools.md` (Discord worked-example swapped for the web channel — closest 1-to-1 swap, identical `lookupOrCreateSession` call shape).
- Historical files (`docs/journal.md` entries, prior-phase handoffs, archived plans, `docs/cross-channel-identity/design.md`) deliberately left intact — they are historical record, not live reference.
- Build clean. Test suite green: 601 tests / 36 suites / 0 failures (unchanged baseline; no new tests needed for a deletion).

**Decisions worth remembering:**
- **Spec fixtures swap to a real channel, don't get deleted.** `lookupOrCreateSession` is still alive because web still uses it. Phase 2 will delete the method and its tests together. Until then, the fixtures use `"web"` instead of a phantom channel string.
- **DynamoDB orphaned records left alone.** The dev table likely has `IDENTITY#discord#…` records and `CHAT_SESSION` METADATA records with `source: "discord"`. App is pre-production, the table is not schema-enforced, orphan cost is negligible — no cleanup script. Confirmed by the user.
- **`source` is and will remain a regular METADATA attribute.** It's never been baked into the session PK; that was only ever IDENTITY's PK. Phase 2's IDENTITY removal will not affect `source`-as-data — it survives as an analytics field on the session record.
- **Operational alerting is Slack, not Discord.** Confirmed during planning: the `slack-alert.service.ts` path is the only operational notification surface. Nothing in Phase 1's scope touched alerting code.

**Next:**
- Phase 2 — IDENTITY pattern removal (Option B from the handoff). Backend-side: delete `IdentityService.lookupOrCreateSession` and the IDENTITY record write entirely; the web controller starts looking up sessions directly via `CHAT_SESSION#<sessionUlid> / METADATA`. Frontend-side: store `sessionUlid` in localStorage instead of `guestUlid`; on session-create, if the stored value resolves to a real session return it, otherwise mint a new one and the frontend overwrites its store. Soft-transition fallback for existing in-flight visitors is unnecessary given pre-production status.
- Phase 2 doc pass should also clean up the two pre-existing nits the reviewer flagged: `data-model.md` line 24 (`sessionUlid` → `session_id`) and `architecture.md` lifecycle paragraph (mention email's `createSessionWithoutIdentity`).

---

## 2026-04-30 — Cross-channel identity Phase 3: email-inbound continuation shipped (feature complete)

**Goal:** Bring returning-visitor recognition to the email channel. Today every fresh inbound email follows Case 1 (extract a session ULID from the recipient's local-part, route to that session). Phase 3 inserts a small dispatcher in front that classifies on the local-part: ULID-shaped → Case 1 unchanged; literal "assistant" → new Case 2/3 dispatch; anything else → reject. With Phase 3 shipping, the cross-channel identity & session continuation feature is **complete end-to-end** for v1: chat-side and email-inbound channels both now recognize returning visitors and load prior conversation context naturally.

**What changed:**
- New `LocalPartClassification` enum (renamed during style pass to `EmailReplyLocalPartClassification` per domain-prefix convention) with three values: `SESSION_ULID`, `ASSISTANT_ENTRY`, `UNRECOGNIZED`. New `classifyLocalPart` method on `EmailReplyService` returns one of those values. ULID matches Crockford-base32 26-char regex. "assistant" matches case-insensitive (`.trim().toLowerCase()`).
- New env var `SENDGRID_REPLY_ACCOUNT_ID` (under the `_id`/`Id` naming convention — never `_ulid`/`Ulid`). Backed by a new `SendGridConfigService.replyAccountId` getter. Required for the "assistant" branch; absent → reject. Single-tenant for v1; per-merchant subdomain → account routing is a separate v2 concern.
- New `IdentityService.createSessionWithoutIdentity` method. Same METADATA-creation work as the existing `lookupOrCreateSession` but skips the per-channel IDENTITY record write. Used exclusively by the email-inbound Case 2 and Case 3-stale paths. The existing `lookupOrCreateSession` stays in place untouched for Discord and web. This asymmetry is deliberate — it avoids the "second stale email lands in the first-stale-session forever" loop, and it's a small step toward the future channel-decoupled identity model the user flagged as a planned refactor.
- Existing Case 1 logic preserved verbatim — extracted into a `handleCase1SessionUlid` method, called from the dispatcher when the local-part classifies as a session ULID. The original 9 email-reply tests pass unchanged.
- Case 2 (unknown sender): new session via `createSessionWithoutIdentity`, sender's email saved to USER_CONTACT_INFO via `if_not_exists(email)`, no `customer_id` set, inbound email body persisted as a new turn. Visitor flows through normal onboarding on first agent reply.
- Case 3 fresh (known customer, prior session < 7 days old): inbound email appended as a new turn under the existing session's PK. No customer_id or continuation_* writes — it's the same session. Sender-mismatch guard reads USER_CONTACT_INFO of the existing session (same security pattern as Case 1) — prevents session hijack via known-email + "assistant" address.
- Case 3 stale (known customer, prior session ≥ 7 days old or null): new session via `createSessionWithoutIdentity`. A single follow-up `UpdateCommand` writes ALL THREE METADATA fields atomically — `customer_id = "C#" + customerUlid` (prefixed), `continuation_from_session_id = capturedPriorLatestSessionId` (bare ULID, captured from the customer-by-email lookup result BEFORE the per-turn write would have overwritten it), `continuation_loaded_at = null`. Phase 2b's existing prior-history loader fires on the agent's first reply for this new session — NO Phase 3 changes to `chat-session.service.ts`.
- The 7-day freshness boundary: `EMAIL_CONTINUATION_FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000`. Strictly less than = fresh; `≥` 7 days = stale. Documented in code; tests cover both sides of the boundary plus the unparseable-_lastUpdated_ and missing-prior-session edge cases.
- Customer-not-found inside the "assistant" branch falls through cleanly to Case 2 (new session, no customer_id, no PII logged). No partial writes.
- `EmailReplyRecord.sessionUlid` made nullable (`string | null`) — for "assistant"-branch dedup records the field is `null` rather than a sentinel string. Operational traceability stays honest.
- `isConditionalCheckFailed` in `identity.service.ts` migrated from the unsafe-cast pattern to `error instanceof Error && error.name === ...` — same fix the style pass applied to `email-reply.service.ts`. Consistency + safety.
- Outbound reply addressing unchanged — new sessions from Case 2 and Case 3-stale use the encoded `<sessionUlid>@reply.<merchant>.com` exactly like every other session. No special outbound code.
- 22 net new tests in `email-reply.service.spec.ts` (existing 9 tests preserved unchanged). 579 → 601. Build clean.

**Decisions worth remembering:**
- **Skip IDENTITY records for email-inbound sessions.** The per-channel `(source, externalId, agentName) → sessionUlid` IDENTITY pattern that Discord and web use was redundant for email-inbound — the dispatcher already has everything it needs (customer-by-email lookup + `customer.latest_session_id` freshness check). Writing IDENTITY records would have created a v1 bug: a customer's second stale email arriving 30 days after the first stale-session was created would be routed back to that month-old session via the IDENTITY lookup, instead of starting fresh as the dispatcher logic intended. Skipping the writes simplifies the design AND closes the limitation in the same beat. The user flagged the broader channel-coupled IDENTITY model as a planned refactor; Phase 3's deliberate omission is a small step in that direction.
- **`SENDGRID_REPLY_ACCOUNT_ID` is single-tenant for v1.** The existing email-reply path doesn't currently resolve an `accountUlid` from the recipient's domain — Case 1 routes purely on session ULID (which is account-scoped by virtue of the session record). For Case 2/3, we needed an account scope for the customer-by-email lookup. The cheapest correct fix: a new env var that the "assistant" branch reads. For v1 (single-account-per-deployment) this works cleanly. Per-merchant subdomain → account mapping is real infrastructure work deferred to v2.
- **The captured prior `latestSessionId` flow is critical for Case 3-stale.** The value comes from the `queryCustomerIdByEmail` result (which returns the customer's current `latest_session_id`), is held in a local variable, and passed directly into the new session's METADATA UpdateCommand BEFORE the agent's first turn fires the per-turn write that updates `customer.latest_session_id` to the new session. Without this capture-then-pass discipline, the loader would later read a `customer.latest_session_id` that points at the new session itself, not at the prior session — and would load no history.
- **Dedup record's `sessionUlid` is nullable for "assistant" entries.** When the dispatcher dedups an inbound email BEFORE deciding which session it belongs to (or before any session exists), there's no real session ULID to record. Writing a sentinel string ("assistant-entry") would have been a semantic lie. Making the field nullable is the honest representation.
- **Sender-mismatch guard pattern carried into Case 3 fresh.** Same security guard Case 1 has — if the sender's email doesn't match the session's `USER_CONTACT_INFO.email`, the email is rejected. Prevents an attacker from knowing a customer's email and the "assistant" address combining to land messages in the wrong session.
- **No new Slack alerts.** Customer-recognition-via-email is not a celebration event worth surfacing; the locked rule from Phase 8b-followup applies absolutely. No PII in logs across all new code paths.

**Next:**
- **Cross-channel identity & session continuation feature is COMPLETE for v1.** Chat-side returning-visitor recognition (CCI-1 + CCI-2a + CCI-2b), email-inbound returning-visitor recognition (CCI-3), prior-history loading via Anthropic's `system` parameter, atomic METADATA writes, per-account isolation preserved, no PII leakage, no new Slack alerts.
- Phase CCI-4 (optional v1.1 polish) remains available for future work: tool-level Zod validation hardening (errors when downstream tools fire without contact-complete data), branded merchant-aware verification email templates, verification re-request rate-limiting telemetry, live Playwright validation of the full returning-visitor flow, the planned channel-decoupled identity model refactor flagged during CCI-3 (consolidating the per-channel IDENTITY records into a unified identity that lives on the Customer record).
- Operational checklist before production deploy: set `SENDGRID_REPLY_ACCOUNT_ID` env var to the active account's id; configure SendGrid Inbound Parse to receive emails at `assistant@reply.<merchantDomain>` (no per-merchant DNS change needed beyond the existing reply subdomain MX records); confirm the prompt cache benefit on the Anthropic system parameter is realized in production traces.

---

## 2026-04-30 — Cross-channel identity Phase 2b: chat-side agent flow shipped

**Goal:** Compose the Phase 1 + 2a substrate into the actual returning-visitor experience. Three connected pieces: (1) `verify_code` captures the visitor's prior session pointer at verification time so the loader has somewhere to read from, (2) a prior-history loader injects visitor profile and last 20 prior-session messages into the agent's context on the next turn, (3) both agent system prompts get a RETURNING VISITOR FLOW section that drives the soft-welcome → verify → "where we left off" flow.

**What changed:**
- New METADATA fields `continuation_from_session_id: string | null` (bare ULID of the prior session) and `continuation_loaded_at: string | null` (ISO timestamp marking when the loader fired). Both default null at session creation. Added to `ChatSessionMetadataRecord` in `src/types/ChatSession.ts`.
- `verify_code` modified: BEFORE the existing `latest_session_id` write moves the customer's pointer to the current session, the tool captures the customer's CURRENT `latest_session_id` (which IS the prior session) and writes it into `metadata.continuation_from_session_id` ATOMICALLY in the same UpdateCommand that sets `customer_id` (Write A). Single round-trip. If the customer has no prior session (`latest_session_id` was null at verify time), `continuation_from_session_id` is also null and the loader will skip naturally on subsequent turns.
- `CustomerService.queryCustomerIdByEmail` extended to return `{ customerUlid, latestSessionId } | null`. Both internal callers in `lookupOrCreateCustomer` updated. `collect_contact_info` calls `lookupOrCreateCustomer` (not `queryCustomerIdByEmail` directly) so it's unaffected.
- New prior-history loader runs in `chat-session.service.ts handleMessage`, AFTER the METADATA fetch, BEFORE the tool loop. Gate: `metadata.continuation_from_session_id !== null` AND `metadata.continuation_loaded_at === null`. Both must hold. On gate-pass: loads Customer record (profile fields), queries prior session's last 20 messages by `_createdAt_` descending then reverses to chronological, builds a dynamic context block via `buildContinuationContextBlock` helper, assigns it to `dynamicSystemContext` (lifted out of the existing while loop so the loader's value isn't silently overwritten on the first iteration). Prior session messages get prepended to the messages array as their original user/assistant pairs. Best-effort `continuation_loaded_at` write via `if_not_exists` handles parallel-turn races.
- **Visitor profile + framing context go into Anthropic's `system` parameter, NOT the messages array.** The Anthropic SDK wrapper in this codebase (`anthropic.service.ts`) already supports `dynamicSystemContext?: string` and builds a two-block content array with `cache_control: { type: "ephemeral" }` on the static base — Option B was wired in at the SDK layer already; the loader just populates the string. The messages array contains ONLY real visitor/agent turns. No synthetic role:user metadata injections.
- Both `lead_capture.agent.ts` and `shopping_assistant.agent.ts` got a new RETURNING VISITOR FLOW section appended to the system prompt: soft-welcome on `customerFound: true` → `request_verification_code()` → handle code paste → `verify_code(code)` → on success, briefly acknowledge prior context and answer current question naturally; on failure (wrong_code / expired / max_attempts / no_pending_code) handle per the locked branching matrix; gracefully give up after sustained failure with no history exposure. Privacy guard: never echo the verification code in the agent's reply.
- `ChatSessionContinuationProfile` type extracted to `src/types/ChatSession.ts` (style pass cleaned up an inline anonymous parameter type during refactor). 34 net new tests across 6 spec files. 545 → 579. Build clean.

**Decisions worth remembering:**
- **The "two pointers, two purposes" design.** `customer.latest_session_id` is the customer's most-recent-active-session pointer (any channel); it gets updated on every assistant turn for verified sessions. `metadata.continuation_from_session_id` is per-session — it captures *where this session continues from*. Without the second pointer, Phase 1's verify_code Write B would overwrite `latest_session_id` to the current session before the loader could read the prior value. Adding a separate METADATA field is cleaner than reworking Phase 1.
- **System-prompt augmentation, not messages-array injection.** The first plan considered injecting visitor profile and framing as `role: "user"` messages prepended to the conversation. User pushed back on that as "hacky" — Anthropic provides a separate `system` parameter specifically for "context about who the agent is and who they're talking to." We built around the right field. The Anthropic SDK accepts `system` as an array of text content blocks with `cache_control` markers, so the static base prompt stays cached while the dynamic per-conversation context varies cleanly. Bonus: the SDK wrapper in this codebase ALREADY had `dynamicSystemContext` plumbed in — the loader just needed to populate the string instead of fake user messages.
- **The `dynamicSystemContext` loop-lift was the highest-risk part of the implementation.** Original code declared `const dynamicSystemContext` inside the tool-loop body. The loader needs to populate it BEFORE the loop runs, so the declaration was lifted out as `let`. arch-planner and the implementer both flagged this — if the in-loop declaration had been left, the loader's value would be silently overwritten on the first iteration. Captured in agent-memory as `feedback_dynamicSystemContext_loop_lift.md`.
- **Loader is best-effort and retryable.** Code-reviewer caught a deviation from the plan: the original implementation stamped `continuation_loaded_at` even when the Customer record failed to load, which would have permanently suppressed the welcome-back flow if the Customer fetch was transient. Fix: nest the flag write inside the `if (customerResult.Item)` block. Now if the load fails, the flag stays null and the loader retries on the next turn. Plan-faithful, low cost, edge-case correctness.
- **System prompt RETURNING VISITOR FLOW edits ARE in scope here, unlike CCI-1 and CCI-2a where prompt edits were deferred.** Phase 2b is the phase that wires the visible product behavior — those prompt sections are the agent-flow component the visitor experiences. Authored verbatim in the plan, copied verbatim into both agent prompts. Neither agent's previous functionality changed; the new section is purely additive.

**Next:**
- Phase CCI-3 — email-inbound continuation. Extend SendGrid Inbound Parse webhook to discriminate by local-part (ULID-shaped → existing Case 1; literal `"assistant"` → new Case 2/3 dispatch). Configure DNS for the `assistant@reply.<merchant>.com` global entry word. Phase 3 reuses the prior-history loader from Phase 2b — when an email-inbound visitor matches a known customer and starts a fresh session, the same `continuation_from_session_id` mechanic captures the prior pointer and the same loader fires.
- Phase CCI-4 — polish (optional v1.1). Tool-level validation hardening (Zod-level errors when downstream tools fire without contact-complete data — flagged Phase 4 candidate by user during 2a planning). Branded merchant-aware verification email templates pulled from the account record. Verification re-request rate-limiting telemetry. Live Playwright validation of the full returning-visitor flow once 2b ships.

---

## 2026-04-30 — Cross-channel identity Phase 2a: chat-side data plumbing shipped

**Goal:** Make the chat-side identity flow data-complete by extending `collect_contact_info` with a customer-lookup-and-create side-effect, lifting Customer creation upstream from `preview_cart` into a shared `CustomerService` method, and tightening `preview_cart` to a hard `customer_id` requirement. No agent system prompts changed (Phase 2b owns those). The substrate Phase 2b will compose into the actual chat-side verification flow is now in place.

**What changed:**
- `CustomerService` (Phase 1's shared service) gained `lookupOrCreateCustomer({ tableName, accountUlid, email, firstName, lastName, phone }) → GuestCartLookupOrCreateResult`. Race-recovery is byte-equivalent to the lifted code: PutCommand with `attribute_not_exists(PK)` → on `ConditionalCheckFailedException` re-Query the GSI → return error if still missing. Returns `{ isError: false, customerUlid, created }` or `{ isError: true, error }` matching the `GuestCartCheckoutBaseResult` discriminant precedent.
- `collect_contact_info` extended with the **trio-completion gate**: on every successful save, the tool reads USER_CONTACT_INFO post-write and METADATA. If `first_name + last_name + email` are ALL non-empty in USER_CONTACT_INFO AND `metadata.customer_id` is null/undefined, the tool calls `lookupOrCreateCustomer` and writes `metadata.customer_id = "C#" + customerUlid` via `if_not_exists` semantics (preserves verify_code's prior write). Returns `{ saved: true, customerFound: bool }` on trio-completion; otherwise `{ saved: true }`. The `customerFound` signal fires AT MOST ONCE per session — subsequent calls short-circuit on customer_id-already-set.
- `preview_cart` simplified: `resolveCustomerUlid` removed entirely. The bare-ULID METADATA `customer_id` write at lines 458–468 removed. Tool reads `metadata.customer_id` from the existing METADATA fetch; strips the `C#` prefix to get the bare customerUlid for the cart record write; returns `MISSING_CUSTOMER_ERROR` (locked text: "This action requires a customer profile. Please collect the visitor's email first.") if `customer_id` is null/undefined. `CustomerService` injection removed (no longer needed). The cart record's `customer_id` field still writes `C#<ulid>` (preserves existing external behavior).
- `generate-checkout-link.tool.ts` strip-prefix at URL construction. The internal METADATA storage now consistently uses prefixed `C#<ulid>`, but the frontend has historically received bare ULID via `customerId=<ulid>`. The tool slices the `C#` prefix off before interpolating into the URL — preserves the external contract exactly.
- Two new types files updated: `src/types/ChatSession.ts` gained `CollectContactInfoTrioCompletedResult` and `CollectContactInfoSavedResult`. `src/types/GuestCart.ts` gained `GuestCartLookupOrCreateResolved`, `GuestCartLookupOrCreateError`, `GuestCartLookupOrCreateResult`. All domain-prefixed per project memory convention.
- `collect-contact-info.tool.spec.ts` created (no spec existed before). 14 cases covering all trio-permutation paths: trio-completes-on-email-save, trio-completes-on-firstName-save, trio-completes-on-lastName-save, all-three-in-one-call, repeat-after-customer_id-set short-circuit, phone-only no-side-effect, plus error paths.
- 22 net new tests across 6 spec files. 523 → 545. Build clean.

**Decisions worth remembering:**
- **Trio-completion gate, NOT eager-on-email-save.** Original brief specified eager creation; user pushed back on the implication that names could be null at create time. Locked: Customer creation only fires when first + last + email are ALL non-empty in USER_CONTACT_INFO. The `GuestCartCustomerRecord.first_name` and `last_name` types stayed `string` (non-nullable). The gate enforces non-empty strings before any create. Empty-string `""` is intentionally treated as missing (truthy coercion catches both `undefined` and `""`).
- **Customer creation is atomic data: agent must collect first/last/email before downstream tools work.** preview_cart hard-requires `metadata.customer_id`. If the agent tries to preview a cart without contact-info-complete state, the tool returns the locked error string. The trio-completion gate at customer-creation IS the de-facto enforcement — bypass it and downstream tools fail loudly.
- **METADATA customer_id format standardized on prefixed `C#<ulid>` for new writes.** Both `verify_code` (Phase 1) and `collect_contact_info` (Phase 2a) write the prefixed form. The Option-A normalization in `chat-session.service.ts` STAYS as legacy compat for in-flight bare-ULID writes from the old preview_cart path — defensive consumer-side, doesn't fight the existing data.
- **Strip-prefix at the URL boundary preserves the frontend contract exactly.** `generate-checkout-link.tool.ts` now extracts the bare ULID from prefixed METADATA storage. The frontend sees bare ULID like it always has; internal storage standardization happens transparently.
- **`if_not_exists` on collect_contact_info's METADATA customer_id write** preserves a verify_code-set customer_id from a prior turn. First-writer-wins: if verification succeeded before contact-info-trio-completion (pathological but possible), the verified link is not clobbered.
- **Brief evolved mid-flow when design assumptions changed.** Original brief had eager-on-email-save + nullable names + GetCommand-only-on-email. User's feedback locked trio-completion + non-nullable names + always-fetch (since any field can complete the trio if the others were saved earlier). The brief was updated, arch-planner refreshed the plan, and the refreshed plan was the authoritative blueprint code-implementer followed. Documented in this entry so future readers don't trip on the stale optimization clauses if they're left anywhere.
- **Reviewer's "fix" to gate GetCommands on email-in-input was correctly rejected.** It would have introduced false negatives — sessions where email was saved earlier and the trio is completed by a later first/last save would silently miss the lookup-or-create. The implementer correctly inferred always-fetch from the trio-completion semantics; the brief had a stale clause from the prior design.

**Next:**
- Phase CCI-2b — chat-side agent flow. Update `lead_capture` and `shopping_assistant` system prompts with the verification flow instructions (soft welcome on `customerFound: true` → `request_verification_code` → `verify_code` → load prior history → "where we left off" continuation). Build the prior-history context loader (last ~20 messages from `customer.latest_session_id` injected as prior turns in the agent's message array, profile fields included; goal is "feels like we left off doing X" continuation, not deep memory). Handle the graceful-failure path (treat-as-new on verify failure, no history exposure). Cost-conscious — bounded token scope.
- Phase CCI-3 — email-inbound continuation. Extend SendGrid Inbound Parse webhook to discriminate by local-part (ULID-shaped → existing Case 1; literal `"assistant"` → new Case 2/3 dispatch). Configure DNS for `assistant@reply.<merchant>.com`.
- Phase CCI-4 — polish (optional v1.1). Tool-level validation hardening (Zod-level errors when downstream tools fire without contact-complete data — flagged as Phase 4 candidate by user during 2a planning), branded merchant-aware email templates, verification re-request rate-limiting telemetry.

---

## 2026-04-30 — Cross-channel identity Phase 1: data model + verification primitives shipped

**Goal:** Lay the structural foundation for cross-channel identity. Phase 1 ships the moving parts in isolation — two linkage fields (`session.customer_id`, `customer.latest_session_id`), a new `VERIFICATION_CODE` DDB record type, two agent-callable tools (`request_verification_code`, `verify_code`), and a plain verification email. No agent system prompts edited with usage instructions, no `collect_contact_info` lookup side-effect, no prior-history context loader. Those each ship in later phases — Phase 1 is the substrate Phase 2 will compose into the actual chat-side verification flow.

**What changed:**
- New types module `src/types/Verification.ts` with `VerificationCodeRecord`, `VerificationRequestCodeResult`, `VerificationVerifyCodeResult` (domain-prefix convention applied during the style pass). New tools `src/tools/request-verification-code.tool.ts` and `src/tools/verify-code.tool.ts` follow the existing `ChatToolProvider` shape. `CustomerService` lifted from `preview-cart.tool.ts` into `src/services/customer.service.ts`; the GSI `(ACCOUNT, EMAIL)` lookup renamed `queryCustomerIdByEmail` per the new `_id` naming convention (Phase 2 will reuse it from `collect_contact_info`).
- `customer_id` initialized as `null` on session creation in `identity.service.ts`; tightened from optional to `string | null` on `ChatSessionMetadataRecord`. `latest_session_id` initialized as `null` on Customer creation in `preview-cart.tool.ts`. The `satisfies GuestCartCustomerRecord` check forces explicit initialization at the call site.
- `chat-session.service.ts handleMessage` adds a best-effort `latest_session_id` UpdateCommand at the post-turn block, guarded inline by `if (customerId !== null)`. The guard normalizes `customer_id` between bare ULID (legacy `preview_cart` writes) and prefixed `C#<ulid>` (new `verify_code` writes) via `customerKey = customerId.startsWith("C#") ? customerId : "C#" + customerId` — Option A from the format-inconsistency triage.
- Verification mechanics: 6-digit zero-padded numeric (consistent at generation, hash input, email body — same string in all three places), SHA-256 hashed at rest (plaintext never written to DDB or any log), 10-minute TTL, 5-attempt cap (checked BEFORE hashing — no timing channel), single-use (record deleted on success), latest-wins overwrite, 3-requests-per-session-per-rolling-hour rate limit baked in via two counter fields on the same VERIFICATION_CODE record. Email sent via `EmailService.send` first, DDB write on success — Option B ordering (one failure mode instead of two; failed write surfaces as `no_pending_code` cleanly).
- Both tools allowlisted on `lead_capture` and `shopping_assistant`. The shopping_assistant prompt's "exactly five tools" enumeration was de-enumerated to "Use only the tools available on your allowed-tool list. That is all." — a correctness fix consequent to the planned allowlist change, NOT a usage-instruction edit (Phase 2 still owns when-to-call instructions). lead_capture's prompt had no analogous count claim, so it was left alone.
- 25 new tests across `customer.service.spec.ts` (4), `request-verification-code.tool.spec.ts` (6), `verify-code.tool.spec.ts` (8), `chat-session.service.spec.ts` (3 latest-session-id guard + 2 format-normalization), `identity.service.spec.ts` (1 customer_id default), `preview-cart.tool.spec.ts` (1 latest_session_id default). 498 → 523. Build clean.

**Decisions worth remembering:**
- **Two correctness-or-die invariants the implementation had to honor.** Zero-padding consistency (generation, hash input, email body — same string in all three places, otherwise codes with leading zeros silently never verify) and attempts-cap-before-hash (no timing side-channel of "is this code length right?"). Both are explicitly tested.
- **VERIFICATION_CODE.email is the authority at verify time, not live USER_CONTACT_INFO.** A visitor who changes their email between code request and verify still gets matched against the email the code was issued for. Captured as a deliberate-mismatch test.
- **Customer_id format inconsistency was already on master pre-CCI-1.** `preview-cart.tool.ts:468` writes bare ULID via `if_not_exists` (first-writer-wins); `verify_code` writes prefixed `C#<ulid>`. The fix lives in the consumer (latest_session_id guard normalizes both formats) — smallest blast radius, no data migration. The inconsistency surfaced because the new write path made it visible; the existing consumer in `preview-cart.tool.ts:204` reads bare and didn't notice.
- **arch-planner correctly punted Customer creation upstream-lift to Phase 2.** The brief considered moving Customer creation from `preview_cart` to email-capture; arch-planner identified that the natural carrier for that change is Phase 2's `collect_contact_info` side-effect work, kept Phase 1 structural.
- **Sub-agent rounds caught two real bugs reviewer-only would have missed.** The customer_id format inconsistency was surfaced by the implementer's deviation flag in round 1 (looking carefully at existing code). The shopping_assistant prompt-vs-allowlist contradiction was surfaced by the reviewer at Step 5. Both required orchestrator pause-and-discuss gates before fix dispatch. The 5-step workflow earned its overhead this phase.
- **DDB TTL is enabled on the conversations table; field name is `ttl`.** Confirmed by user before dispatch. Stale verification records are reaped automatically; application logic still validates `expires_at` independently.

**Next:**
- Phase CCI-2 — chat-side continuation. Add the `collect_contact_info` email-lookup side-effect (`customerFound: true|false` signal in the tool result drives the agent's verify-or-not decision). Lift Customer creation upstream to the email-capture moment. Update both agents' system prompts with the verification flow instructions (soft welcome → request code → verify → load prior history). Build the prior-history context loader (last 20–30 messages from `customer.latest_session_id`). Handle the graceful-failure path (treat-as-new on verify failure, no history exposure).
- Phase CCI-3 — email-inbound continuation. Extend the SendGrid Inbound Parse webhook to discriminate by local-part (ULID-shaped → existing Case 1; literal `"assistant"` → new Case 2/3 dispatch). Configure SendGrid Inbound Parse + DNS for the global `assistant@reply.<merchant>.com` entry word.
- Phase CCI-4 — polish (optional v1.1). Verification re-request rate-limiting telemetry, branded merchant-aware email templates, any operational follow-ups from running CCI-1/2/3 in production.

---

## 2026-04-29 — Cross-channel identity & session continuation — design spec complete

**Goal:** Recognize a returning visitor across channels (chat + email today, SMS later) so their conversation continues instead of restarting. Identity is the email; the canonical entity is the existing Customer record (already created by `preview_cart` with a `(ACCOUNT, EMAIL)` GSI). The design extends that foundation upstream to email-capture moment, adds a verification flow for chat, and links chat sessions to customers so prior history can be loaded on continuation.

**What changed:**
- Brainstormed the full design with the user via the visual companion across ~12 rounds of locked-in conceptual decisions: scope (returning-visitor recognition + bidirectional chat ↔ email continuation + SMS architectural readiness); chat trust model (B+C+A merged: verify-via-email-code, soft welcome, full continuation); email-inbound trust (naturally trusted via SPF/DKIM); agent flow (tool-driven via two new tools + a side-effect on `collect_contact_info`); verification mechanics (DDB-stored, 6-digit numeric, 10-min TTL, SHA-256 hashed at rest, 5-attempt cap); session-customer linkage (two new fields, no new GSI for v1); email-inbound continuation freshness (7-day window); email addressing (global `assistant@reply.<merchant>` entry word, per-merchant subdomain).
- Wrote `docs/cross-channel-identity/design.md` (366 lines) with the full design, decisions log, implementation decomposition sketch (4 phases proposed), and open implementation questions for phase planning.
- Wrote `docs/cross-channel-identity/HANDOFF.md` for the fresh agent that will pick up implementation.
- Added `.superpowers/` to `.gitignore` (brainstorming session workspace shouldn't pollute history).
- **No implementation work started yet.** Design is the artifact; implementation handed off to a fresh Claude Code session for context-budget reasons.

**Decisions worth remembering:**
- **The Customer record + email GSI already exist** (`src/tools/preview-cart.tool.ts:604–625`). This is the data foundation everything else extends. We don't design a new entity — we extend the existing one upstream and downstream.
- **Slack is not a PII-safe destination** (locked from Phase 8b-followup) — the same rule extends here. No verification codes, no customer profiles, no continuation events surface to Slack with PII.
- **Naming convention for new fields: `_id` / `Id`, never `_ulid` / `Ulid`.** Existing TS variable names (`sessionUlid`, etc.) are not refactored — convention applies forward only.
- **Spec vs. phase brief are different artifacts.** Design spec = the THINKING (one document covering the whole feature). PROMPT_DISCOVERY_SERVICE-formatted phase brief = the DOING blueprint (one per shippable phase). Spec lives at `docs/cross-channel-identity/`; phase briefs continue to live at `docs/knowledge-base/tasks/`.

**Next:**
- A fresh Claude Code session picks up from here. They read the design + HANDOFF + journal, then draft Phase 1's task brief (data model + verification primitives) per the PROMPT_DISCOVERY_SERVICE template, surface for user review, and dispatch the standard 5-step sub-agent workflow.
- Handoff exists because the original orchestrator (this session) hit ~70% context — clean break point before any implementation work began was preferable to running out mid-phase.
- The 4 proposed phases (data model + verification primitives → chat-side continuation → email-inbound continuation → polish) are sketched in the design's decomposition section. Each ships through the standard 5-step workflow.

---

## 2026-04-28 — Slack alert enrichment with cart details (Phase 8b-followup)

**Goal:** Address feedback from the frontend Playwright session that the existing Slack alerts (cart_created, checkout_link_generated) felt thin — the team got accountId + sessionUlid but no business context. Enrich both alerts with the cart ID and a per-item breakdown so the team has actionable signal in real time, while holding a hard line that no customer PII enters Slack under any circumstance.

**What changed:**
- `SlackAlertService.notifyCartCreated` and `notifyCheckoutLinkGenerated` extended with `guestCartId` and a typed `items: readonly CartItemAlertEntry[]` (name, quantity, subtotalCents). Conversation_started alert byte-for-byte unchanged — pre-onboarding there is nothing meaningful to add.
- Two new Slack-specific helpers landed: `formatCentsAsUsd` (private method on the service — single source of truth for cents → `$X.XX` rendering) and `escapeSlackMrkdwn` (module-scope, escapes `&`/`<`/`>` per Slack's spec; applied to every interpolated item name).
- `PreviewCartTool.execute()` threads guestCartId + items from the cart preview response that's already in scope at Step 12 — no new DDB read.
- `GenerateCheckoutLinkTool.execute()` adds Step 5b: a non-fatal cart-record fetch wrapped in try/catch. On success the alert fires with full items + total. On failure (network blip, transient DDB error) the alert still fires with empty items + $0.00 total, and the checkout URL generation in Steps 5–6 is entirely unaffected. The user-facing tool result never breaks.
- Spec coverage: 16 new tests across the service spec (items rendering, currency formatting, mrkdwn escaping, edge cases) and the two tool specs (guestCartId + items assertions, non-fatal failure path test, DDB call-count audit). 482 → 498. Build clean.

**Decisions worth remembering:**
- **Slack is not a PII-safe destination.** Hard rule going forward: no first name, no last name, no email, no phone in any Slack alert, ever. Slack has no equivalent of Sentry's `beforeSend` scrubber; whatever we send sits in message history forever, is reachable by Slack workspace integrations, and could become a B2B compliance issue when partners ask "where does our shoppers' email go?" Cart items, system IDs, and totals are explicitly fine — they're business signal, not customer identity. If an authorized human needs the actual customer, they take the IDs and look them up in DDB where access is properly controlled.
- **Non-fatal enrichment reads are a viable pattern when fire-and-forget is the calling convention.** The original brief constraint was "no new DDB reads" because of an incorrect assumption that GenerateCheckoutLinkTool already had cart data in memory. arch-planner caught the assumption error during planning. The graceful-degradation try/catch (alert fires either way, never blocks user) gave us the locked contract without compromising the safety guarantee.
- **arch-planner caught a wrong premise in the brief during planning.** This is the second time the sub-agent workflow has surfaced something a less-rigorous inline edit would have papered over (Phase 8d-essential close-out caught a similar class of issue). Worth the workflow overhead, especially for cross-module changes touching new external surface (Slack payloads).

**Next:**
- Frontend will run a third Playwright round to confirm the enriched alerts render correctly in `#instapaytient-agentic-ai-alerts`.
- Cosmetic case normalization on cart preview line items ("Med Administration" vs "Med administration") is the only remaining open finding from the original Playwright report — small backend renderer fix, deferred until convenient.
- Journal at 530+ lines now (over the 500-line archive threshold for the second time) — archive operation deferred per user preference; whenever the file growth becomes uncomfortable, cut the oldest third into `docs/journal-archive-2026.md`.

---

## 2026-04-28 — Frontend Playwright validation; wired KB into shopping_assistant

**Goal:** Run the cross-stack v1 validation by having a separate Claude session drive Playwright against the iframe widget on the frontend, talking to the shopping_assistant agent like a real visitor. The backend was already verified end-to-end (see entry below). This was the user-facing layer.

**What changed:**
- Frontend Playwright session ran a full happy-path conversation through the iframe: kickoff, onboarding, multi-item cart, checkout link generation. All 4 jailbreak/social-engineering probes refused cleanly. No crashes. Cart math correct. Checkout URL well-formed. Server-authoritative kickoff held — only 1 sentinel POST across 11 turns — verifying the 2026-04-21 cutover live.
- Highest-value finding: when asked descriptive questions about specific services ("What's included in the Meet and Greet Party?"), shopping_assistant deflected to "ask a team member" instead of grounding in the KB. Diagnosis: shopping_assistant.agent.ts had no lookup_knowledge_base in its allowedToolNames — the agent literally couldn't see the KB tool. lead_capture had it; shopping_assistant did not. Cross-stack issue invisible to backend tests.
- Fix: added lookup_knowledge_base to shopping_assistant's allowlist; added KNOWLEDGE-BASED QUESTIONS + GROUNDING DISCIPLINE sections to its system prompt, copying the prioritization rule that was already designed into lead_capture's prompt; relaxed the SCOPE-NOT exclusion so the agent can answer hours/locations/policies when documented in the KB. Spec test fixture updated for 5 tools instead of 4. Build clean, 482/482 tests pass.

**Decisions worth remembering:**
- **The catalog-vs-KB prioritization rule is now consistent across both agents.** list_services is the source of truth for pricing and what's offered; lookup_knowledge_base is the source of truth for descriptive/procedural/policy content. On collision the catalog wins for pricing, the KB wins for policies. If a customer puts prices in a KB PDF, the agent ignores them — list_services is always authoritative for price.
- **The lookup_knowledge_base contact gate is intentionally relaxed for general info questions.** Areas served, hours, cancellation policy, etc., can be answered before contact capture. The hard gate (collect first/last/email before pricing, cart, or specific service references) still applies.
- **This fix bypassed the 5-step sub-agent workflow.** User explicitly authorized inline edits for this class of change — configuration and prompt content, no logic. The standing "all code touches via sub-agents" discipline rule remains in place for actual logic touches; one-off bypass for this case only.

**Next:**
- Frontend agent will run a second Playwright round to confirm the fix resolves the deflection (visitor asks "what's included in X?" → agent grounds in KB instead of deflecting).
- Cosmetic case normalization on cart preview ("Med Administration" vs "Med administration") is the only other open finding — small backend renderer fix, not blocking.
- Double-confirmation flow (prose recap → confirm → cart card) and minor naming redundancy ("Sam"/"Sam" in one turn) are cosmetic and explicitly deferred.

---

## 2026-04-28 — KB v1 verified end-to-end; caught a Phase 7c BullMQ DI bug along the way

**Goal:** Stamp v1 on the knowledge base feature by running a full live verification of the pipeline against real services (Qdrant, Voyage, Anthropic, Redis, DynamoDB) — not more Jest tests, but actual end-to-end smoke. The 482 Jest tests were already green, but tests don't catch what tests don't exercise. Wanted "100% confidence" before declaring done.

**What changed:**
- All 10 verification scenarios passed live: auth gate (no header / wrong key both 401, byte-identical responses so no enumeration), happy-path ingest with async processing (~6s for a 2-chunk doc), idempotent re-ingest with byte-identical UUIDv5 IDs across re-POSTs, update flow correctly cleaning the chunk_index=1 zombie when doc shrinks 2→1, per-account isolation at both DDB and Qdrant layers, delete flow cleaning both stores, final state sweep clean.
- Retrieval scenario verified the lead_capture agent calls `lookup_knowledge_base` (twice for a two-part question — proper grounding discipline), Qdrant returns relevant chunks with similarity scores 0.5–0.6, and the agent's reply uses the doc's content verbatim ("Monday through Friday 8am-6pm", "$5 per walk", "48 hours advance notice") with natural attribution and no internal IDs leaked.
- **Caught a Phase 7c boot bug**: `BullModule.forRootAsync` was injecting `KnowledgeBaseConfigService` from `AppModule.providers`, but BullModule runs in its own DI scope and couldn't see services from the host module's providers without an explicit `imports: [...]`. The 482 Jest tests missed it because BullMQ is mocked everywhere. The app refused to boot with `UnknownDependenciesException`. Bug shipped in commit `52ad724c` (Phase 7c) and survived through every subsequent phase.
- Fix: extracted `KnowledgeBaseConfigService` into a dedicated `KnowledgeBaseConfigModule` (mirrors the typed-config-service-pattern the rest of the codebase uses) and added `imports: [KnowledgeBaseConfigModule]` to the BullModule async config. App now boots clean. Tests still 482/482.

**Decisions worth remembering:**
- **Live verification catches what unit tests can't.** Mocked dependencies in Jest mean the real DI graph never runs in CI. Phase 7c shipped a boot bug that survived through every subsequent phase. The smoke test caught it the first time we tried to boot. Worth doing live verification at every major milestone, not just at v1.
- **Voyage dim guard ran for real**: `[event=boot_ok dim=1024 probeMs=191]` in the boot log. Phase 8d-essential's correctness invariant is now proven live, not just in tests.
- **Deterministic Qdrant point IDs work end-to-end**: the same `(account_id, document_id, chunk_index)` produces byte-identical UUIDv5s across re-ingest. The update flow correctly upserts in-place AND cleans up chunks that no longer have a counterpart in the new chunk_count. Zombie-chunk problem solved at the live-data layer, not just in unit tests.

**Next:**
- Operational items still pending the partner integration: the ecommerce API needs to be configured to send `X-Internal-API-Key` header (and a stable `external_id` per document) on ingestion calls. Production deploy needs `KB_INTERNAL_API_KEY` (≥32 chars) set as a secret on every environment.
- Playwright frontend test session is the only remaining v1 gate beyond what shipped today — covers the iframe widget side, complementary to this backend-side verification. To be run with a different agent.
- Per-customer billing instrumentation (per-account token meter, plan/quota metadata, monthly usage export) is the next backend workstream — designed but not yet built. Tiered-subscription-with-overage pricing model approach was discussed and locked during this session.

---

## 2026-04-28 — KB integrity hardening shipped (Phase 8d-essential)

**Goal:** Close the two real correctness gaps in the KB pipeline before stamping v1 — silent vector corruption from a Voyage-vs-Qdrant dimension mismatch, and zombie-chunk accumulation on retry of partial-failure updates. The full Phase 8d roadmap was a bundle of operational hardening items deferred from earlier phases; this sub-phase ships only the two v1-blocking ones and explicitly defers the rest until production data justifies them.

**What changed:**
- `VoyageDimGuardService` runs at boot (after DI resolution, before `app.listen`), embeds a constant probe input via Voyage, asserts the returned vector length matches the configured Qdrant collection dimension (1024 for `voyage-3-large`). On mismatch or terminal Voyage outage: Sentry capture with `category: "voyage-dim-guard"` + `severity: "fatal"` tags, then `process.exit(1)`. Two retries with linear backoff on transient failures.
- Deterministic Qdrant point IDs via UUIDv5 from `(accountId, documentId, chunkIndex)` — single namespace constant `KB_POINT_ID_NAMESPACE` hardcoded in `src/utils/knowledge-base/qdrant-point-id.ts` with an explicit immutability comment. The single `crypto.randomUUID()` call site in `writeQdrantPoints` swapped to use the helper.
- 22 new tests covering dim-guard pass/fail/retry/exhaust paths, deterministic ID generation, and retry idempotency. Suite count 460 → 482.

**Decisions worth remembering:**
- **In-flux/compensation marker was over-engineered and dropped.** With deterministic IDs alone, every step of the update flow is independently idempotent — `delete-by-document_id` is idempotent, embeds are deterministic, upsert with deterministic IDs cannot duplicate. Retry-from-scratch produces clean state at every crash point. A marker would only matter if the worker tried partial-recovery cleverness, which it does not.
- **No mass migration of existing random-UUID Qdrant points.** Pre-existing points retrieve fine; documents migrate naturally on their next update via the existing delete-by-document_id flow. Hybrid state is acceptable and self-healing.
- **Boot-time Voyage outage = failed deployment by design.** A Voyage outage during a rolling deploy will leave new instances stuck while old ones keep serving. Sentry `voyage-dim-guard` events should be wired into deployment health monitoring.

**Next:**
- Playwright API test suite covering the ingest → chunk → embed → enrich → store → retrieve pipeline plus chat-with-tool-call golden flows. Final v1 gate before stamping the Jest + Playwright suites as the v1 contract.
- Coordinate with the ecommerce API to send `X-Internal-API-Key` header and a stable `external_id` per document on ingestion calls.
- Phase 8d non-essential (stuck-job detector, Anthropic retry-with-backoff, orphan cleanup, GSI), 8e (operational endpoints), 8f (quality/cost levers including Haiku swap) all explicitly deferred until production data justifies them.

---

## 2026-04-27 — Observability + internal-API security shipped (Phases 8a, 8b, 8c)

**Goal:** Close the operational visibility and access-control gaps before customer #1. Errors must be auto-surfaced (Sentry) so operators don't read logs to find problems. Page-worthy business events must be loud (Slack) so the team sees activity in real time. The KB endpoints must be locked down to upstream callers only — no public surface, no per-user auth, just a trusted-caller handshake.

**What changed:**
- **Phase 8a — Sentry error tracking.** `@sentry/nestjs` integrated, wrapped in a project-controlled `SentryService` for swappability. `category` tags on every captured exception (voyage, qdrant, enrichment, ingestion-job, slack, voyage-dim-guard). PII scrubbing via `beforeSend` strips chat messages, document text, contact info, and the `x-internal-api-key` header before any event leaves the process. `SENTRY_DSN` unset → SDK no-ops cleanly for local dev.
- **Phase 8b — Slack business-signal alerts.** Standalone `SlackAlertService` posts to `#instapaytient-agentic-ai-alerts` on three events: conversation started, cart created (item count > 0), checkout URL generated. Errors stay in Sentry; Slack is celebrations-only — adding error alerts here is a regression. Fire-and-forget pattern with `.catch(() => undefined)`; never blocks user flow.
- **Phase 8c — Internal-API authentication.** `InternalApiKeyGuard` (NestJS `Guard`, `crypto.timingSafeEqual` constant-time compare with length-check guard) decorates `KnowledgeBaseController`. Header `X-Internal-API-Key` matched against `KB_INTERNAL_API_KEY` env (Zod `min(32)` validation, required at boot). 401 on any rejection without leaking which check failed.

**Decisions worth remembering:**
- **This API is internal-only forever — strategic commitment.** Two caller classes: iframe-facing chat endpoints (their own per-conversation auth model) and trusted upstream servers via shared secret. There is no third class. No JWT verification, no user identity on this API, no admin UI. New partners get their own deployment with their own secret. This single decision unblocked 8c's design entirely.
- **Slack scope is celebrations only.** Mixing error alerts and success alerts in one channel turns the channel into noise. Sentry owns errors; Slack owns business positives. Keep the boundary clean.
- **`x-internal-api-key` is scrubbed at multiple Sentry layers.** Explicit headers check in `scrubEvent` plus addition to `PII_KEYS` covers `event.request.headers` AND breadcrumb data + `event.extra` + `event.contexts`. Defense in depth — one capture path missing redaction would leak the secret.

**Next:**
- Phase 8d-essential (integrity hardening) immediately after — see entry above.
- Future evolution: per-partner key registry when partner #2 onboards. Today: single global `KB_INTERNAL_API_KEY`. The guard's internal logic is structured so this is a swap behind the same external interface, no caller changes.

---

## 2026-04-24 — Knowledge base feature reaches feature-complete (Phases 1–7c)

**Goal:** Build a per-account knowledge base the conversational layer retrieves from in real time, so each customer's agent quality is bounded by their own context rather than the base model's training data. Ship as an internal-only async pipeline with per-account isolation as the load-bearing correctness invariant.

**What changed (seven phases):**
- **Phases 1–3 (foundations):** Qdrant collection with `account_id` payload-filter contract, Voyage `voyage-3-large` 1024-dim embeddings via `VoyageService` + auto-batch splitting, natural-boundary chunker (2000-char target with 200-char overlap, snaps to paragraph/sentence/word breaks).
- **Phases 4–5 (ingestion + retrieval):** `POST/GET/DELETE /knowledge-base/documents` controller, DynamoDB metadata at `PK = A#<accountUlid>` / `SK = D#<documentId>` with `(account_id, external_id)` keying for caller-side idempotency, Qdrant vector writes with per-chunk payloads, `lookup_knowledge_base` retrieval tool wired into a hybrid LeadCapture agent.
- **Phases 7a–7c (lifecycle + quality + async):** document update + delete that cleanly removes prior Qdrant chunks before re-ingesting; Claude enrichment per chunk (SUMMARY / QUESTIONS / KEY TERMS embedded combined with the chunk text — modest but real lift on the dog-walking benchmark, documented honestly in `docs/knowledge-base/benchmark-findings.md`); Redis + BullMQ async ingestion queue so the controller responds in milliseconds while embedding + enrichment runs in the background worker.

**Decisions worth remembering:**
- **Per-account isolation is non-negotiable.** Every Qdrant query carries an `account_id` filter. Every DynamoDB key includes the account. There is no single-tenant fallback path. This isn't just a feature — it's the load-bearing correctness invariant of the whole multi-tenant design.
- **Cart total units are cents, not dollars.** `preview-cart.tool.ts` sums `cartItem.total` which is integer cents per the `GuestCart` contract. Documented inline at the call site to prevent a future "fix" from multiplying by 100.
- **DynamoDB PK/SK are uppercase.** Lowercase passes type-checks and fails at runtime with `ValidationException`. Bit us once on Phase 4; the convention is now strict across all KB code.
- **Approach 2 + Qdrant locked early.** An earlier benchmark phase using real dog-walking-company data validated the approach before scaling; full architecture in `docs/knowledge-base/target-architecture.md`.

**Next:**
- Operational hardening (Phase 8) — observability, security, integrity guards. See the two entries above.
- Hybrid LeadCapture agent now uses retrieval; the bare LeadCapture agent stays available for accounts without a KB.

---

## 2026-04-21 — Server-authoritative kickoff state: full cutover across both repos

**Goal:** Complete the transition to "session state is fully server-authoritative" as a principle. Onboarding and budget were already on the server; kickoff (the auto-greeting trigger) was the last piece still using frontend localStorage as its source of truth. Move it onto the server so a single rule — "server state is ground truth, client is a hint" — applies to every session-lifecycle decision.

**What changed (backend side, across two commits):**
- **`cc1427bc`** shipped the kickoff mechanism: frontend auto-sends `__SESSION_KICKOFF__` as a user message after onboarding completes; backend processes it through the existing `handleMessage` path (no new endpoint) to trigger the agent's greeting. `getHistoryForClient` filters the marker out of hydrated history so the sentinel never surfaces to the UI.
- **`4cb900fd`** made kickoff state server-authoritative. Added `kickoff_completed_at?: string` to `ChatSessionMetadataRecord`. Exposed it as `kickoffCompletedAt: string | null` on both `POST /chat/web/sessions` and `POST /chat/web/sessions/:sessionUlid/onboarding` responses, mirroring the existing `onboardingCompletedAt` shape byte-for-byte. `handleMessage` special-cases the kickoff marker: on the first successful turn, stamps the timestamp via `UpdateCommand` with `if_not_exists` (write-once, never clobbered). On any subsequent kickoff message for a stamped session, short-circuits — queries history for the stored welcome and returns it with empty `toolOutputs`, never re-calling Anthropic. This is strict last-touch idempotency: same cart-preview pattern we use for mutation-idempotent tools.
- Frontend cutover landed in the widget repo today (their commits `cfa5188` + `7390d11`), ripping out `hasKickoffFired` / `markKickoffFired` / `kickoffStorageKey` / the `instapaytient_kickoff_<sessionUlid>` localStorage key. Dispatch decision now reads `session.kickoffCompletedAt === null` on both the post-onboarding path and the returning-visitor hydration path. Defense-in-depth render + hydration filters for the sentinel stayed in place.
- Full Playwright E2E verified end-to-end: fresh-visitor kickoff fires once with no localStorage key written, hard-refresh doesn't re-dispatch (stamp observed server-side), a manual race probe short-circuits with the stored welcome in 12ms (no Anthropic call), and the regression sweep (contact gate, catalog gate, three-paragraph checkout URL, post-link cart edit, URL reassurance) all still pass.

**Decisions worth remembering:**
- **Idempotent replay over 409 Conflict or regeneration.** When a repeat kickoff arrives for a stamped session, the backend returns the stored welcome without re-spending Anthropic or producing a different greeting. This matches how mutation-idempotent tools (`preview_cart`, `generate_checkout_link`) behave and keeps analytics sane — one kickoff event per session, same text, stable timestamp.
- **Stamp after message storage, not before.** `kickoff_completed_at` is written only after the welcome's `PutCommand` commits successfully. This makes "stamped but no greeting in history" architecturally impossible. A failed storage → no stamp → next load retries naturally. A failed stamp (best-effort, warn-and-swallow) → next load retries → backend short-circuits from the stored welcome. No silent-failure gaps.
- **Frontend's pushback on localStorage was correct.** Initially the frontend shipped a localStorage guard per my earlier suggestion. Two rounds later they pushed back with "server state should be the source of truth, matching the onboarding precedent" — and they were right. Both guards doing the same job with localStorage being redundant was the wrong architecture; the server-authoritative model is cleaner and the cutover ripped ~40 lines of client-side state out. Good instinct to trust: when the client's "guard" is duplicating what the server already knows, move the decision to the server.
- **Reusing `handleMessage` for kickoff was the right call, not a new endpoint.** An earlier design sketch proposed a dedicated `POST /chat/web/sessions/:ulid/welcome` endpoint that would generate the greeting out-of-band. That would have added a `bootstrapWelcome` service method, a new controller route, a new response type, and duplicated the storage path. The frontend's "just send the kickoff string through the existing endpoint and filter it from UI" approach avoided all of that complexity at the cost of one magic string.

**Next:**
- The server-authoritative principle now applies consistently across onboarding, budget, and kickoff. If any future per-session state is introduced (preferences, saved searches, etc.), it should follow the same shape — snake_case field on `ChatSessionMetadataRecord`, camelCase on the wire, echoed on `POST /sessions` and `POST /onboarding` responses, written via `UpdateCommand` with `if_not_exists`.
- Still queued separately from this work: CSP `frame-ancestors` as the browser-enforced companion to the Referer gate, and the ecommerce-side follow-up for AI attribution (ecommerce repo reads `aiSessionId` off the checkout URL → Stripe metadata → `AttributionRecord` written to shared DynamoDB table).

---

## 2026-04-20 — tool_outputs: backend-enforced latest-only dedupe + per-call call_id

**Goal:** Close a correctness gap in the `tool_outputs` contract. The backend was emitting every tool result in a turn, including stale ones — if a "latest-wins" tool like `preview_cart` was called twice in a turn (rare but possible), the earlier result described a cart record that had already been overwritten. That's not a polish issue, it's actively wrong data heading to the frontend. Also gave every tool_output a stable `call_id` so the frontend's React-key strategy can drop its composite-key workaround.

**What changed:**
- **`ChatTool` interface gains `emitLatestOnly?: boolean`.** Each tool declares its own dedupe semantic at registration time. `preview_cart` and `generate_checkout_link` set it to `true` (their results describe mutable state the latest call overwrites). Other tools (`save_user_fact`, `collect_contact_info`, `list_services`) leave it unset — their calls are independent events and multiple-per-turn is valid.
- **`ChatSessionService.handleMessage` applies the dedupe.** After collecting all tool outputs for the turn, it reads `toolRegistry.getAll()`, builds the set of tool names with `emitLatestOnly: true`, and filters the output array to keep only the final entry per latest-only tool name. Other tools pass through unchanged.
- **`WebChatToolOutput` gains `call_id: string`.** Populated from the Anthropic `tool_use_id` (e.g., `toolu_01K...`) — stable, unique per call, naturally perfect as a React key. Emitted on every entry.
- Tests cover both semantics: multi-call `preview_cart` keeps only the last entry; parallel `save_user_fact` calls both survive with distinct `call_id`s.

**Decisions worth remembering:**
- **Dedupe semantic belongs on the tool, not a central allowlist.** Hardcoding `["preview_cart", "generate_checkout_link"]` in the service would've shipped for v1 but doesn't scale. Each tool knowing its own mutation pattern is the right long-term shape — adding a new latest-wins tool is just a one-line flag on the tool class, no central registration or service edit.
- **Why dedupe in the backend even though the frontend already has a safety net for it.** The frontend shipped within-turn dedupe per earlier guidance from this side. That code becomes a harmless no-op now, not wasted work — belt and suspenders on an invariant. But the backend is the proper source of truth for "which tool_output represents reality" — it's the only layer that knows a `preview_cart` call mutated the cart record. Pushing that reasoning to every consumer would have been a slow leak of correctness responsibility out of the API contract. Owning it here means future consumers (dashboards, analytics pipelines, different frontend clients) all get the right data by default.
- **`call_id` was free to add.** Anthropic already generates a unique `tool_use_id` per call and threads it through the tool_result block. Exposing it on the wire costs nothing and buys the frontend a stable key without composite-key tricks. The frontend can migrate their `${index}-${output.toolName}` strategy to `output.callId` whenever it's convenient — old code keeps working in the meantime.

**Next:**
- Frontend work from this cycle (cart preview card rendering + registry) is ready to commit once live Playwright E2E passes against the updated backend contract. Backend is at commit `<filled after commit>`, waiting for frontend.
- When frontend migrates React keys to `output.callId`, the composite-key code and within-turn dedupe code both become deletable. Optional cleanup on their side.

---

## 2026-04-20 — Cart confirm-before-checkout: split create_guest_cart + generic tool_outputs on sendMessage

**Goal:** Give visitors a chance to verify their cart before being dropped onto checkout, and let the frontend render the cart as a deterministic UI component instead of relying on LLM prose. Shipped as a tool-surface change plus a small generic wire-level addition to `POST /chat/web/messages` so any agent's structured tool results can reach the UI.

**What changed:**
- **`create_guest_cart` tool deleted, split into two:**
  - **`preview_cart(items)`** — writes or replaces the cart record in DynamoDB and returns a structured `CartPreviewPayload` (lines + quantities + unit price + total). Idempotent: reuses the session's `cart_id`/`guest_id`/`customer_id` on repeat calls so URL stays stable across edits.
  - **`generate_checkout_link()`** — zero-arg, reads persisted cart IDs from session METADATA, builds the checkout URL (preserving the `aiSessionId` attribution param byte-for-byte). Pure read, idempotent.
- **Session `METADATA` gains four optional fields** (`cart_id`, `guest_id`, `customer_id`, `customer_email`) all written via `if_not_exists` so the IDs are stable across repeat previews. Cart record write uses `UpdateCommand` with `if_not_exists` on `_createdAt_` so cart age is preserved through edits.
- **Generic `tool_outputs` on `POST /chat/web/messages` response.** `WebChatSendMessageResponse` now optionally carries `tool_outputs: { tool_name, content, is_error? }[]`. The backend collects every tool_result from the turn, pairs it with its tool_use name, and surfaces it agent-agnostically — no shopper-specific shape on a shared endpoint. Frontend registers per-tool renderers (`preview_cart` → cart card, future tools → their own components), and tools it doesn't know about are silently ignored.
- **Shopping assistant prompt rewritten**: step 6 now requires `preview_cart` → wait for explicit visitor confirmation → `generate_checkout_link` → present URL. Boundaries section updated from "three tools" to "four tools."

**Decisions worth remembering:**
- **Paired-ID check for crash safety.** `preview_cart` treats `cart_id` + `guest_id` as a set: if either is missing on read (e.g., a crash ever split a previous write), mint both fresh. Prevents orphaned cart rows at stale SKs. Small fix, but the naïve independent-field check would have silently accumulated garbage rows in a crash scenario.
- **Agent-agnostic `tool_outputs` instead of a `cart_preview` field.** The tempting first design was to bolt a `cart_preview: CartPreviewPayload | null` onto the response. That hardcodes shopper-specific concerns into a shared endpoint and breaks the moment a non-shopper agent has its own renderable tool. The generic array of `{ tool_name, content }` entries scales — adding new agents with new tools requires zero backend changes, only a frontend-side renderer registration.
- **Stable cart_id across previews = stable checkout URL across edits.** Because the ecommerce store hydrates from live cart state when the URL is opened, the same URL keeps working after the visitor adds or changes items. No URL invalidation, no versioning — the URL is a pointer, not a snapshot. Matches Shopify's cart/checkout separation pattern.
- **`_createdAt_` on the cart is preserved via `UpdateCommand` + `if_not_exists(_createdAt_, :now)`, not clobbered by `PutCommand`.** Worth one extra expression clause to avoid resetting "when the cart was first built" on every preview — analytics and the ecommerce side care about cart age.

**Next:**
- **Frontend rendering (cross-repo, not done yet):** the widget's ChatPanel registers a per-tool renderer for `preview_cart` that parses the tool_result JSON and renders a cart card component (qty × name × variant × unit price × line total × cart total). Without this, the visitor sees the agent's "here's your cart" prose but no visible cart card.
- Cart editing tool (`update_cart`) still deferred — `preview_cart`'s idempotent replace-array semantics cover the "change my selection" flow for now.
- Still queued separately: CSP `frame-ancestors` as the browser-enforced companion to the Referer gate.

---

## 2026-04-20 — AI conversion attribution: chat-service half shipped (write-first, read-later)

**Goal:** Lay the foundation for measuring AI-driven revenue with server-side accuracy. The single most important business question for an AI chat product is "how much money is the AI actually making?" — and until this commit, there was no way to close the loop between "a visitor chatted" and "a visitor paid." This ships the chat-service half: the session ULID now flows out on the checkout URL and the DynamoDB record shape is locked in as a shared contract.

**What changed:**
- `create_guest_cart` tool now appends `&aiSessionId=<sessionUlid>` to the checkout URL it generates. The param rides through the customer's ecommerce store, into Stripe Checkout Session `metadata.ai_session_id`, and out the back of the Stripe webhook — unmodified end to end by design.
- New `src/types/Attribution.ts` defines two records that the ecommerce backend will write into this service's conversations table once a payment completes with `ai_session_id` in metadata:
  - `AttributionRecord` — session-scoped (`PK=CHAT_SESSION#<ulid>, SK=ATTRIBUTION#<paymentIntentId>`). Carries amount, currency, stripe IDs, order ID, cart ID, status, and denormalized account/agent fields for reporting-time queries.
  - `AttributionPointerRecord` — account-scoped (`PK=A#<ulid>, SK=ATTRIBUTION#<isoTimestamp>#<paymentIntentId>`). Lets you `Query` all conversions for an account sorted by time with no new GSI.
- File header comment reserves `ATTRIBUTION_EVENT#` and `ATTRIBUTION_INFLUENCED#` SK namespaces for future extensions so v1 records remain cleanly filterable if/when funnel events or AI-influenced tracking land later.
- Attribution model is **strict last-touch, payment-only.** A record exists if and only if a completed payment carried `ai_session_id` end-to-end. No "AI-influenced" bucket, no funnel-stage events, no read endpoints in v1.

**Decisions worth remembering:**
- **Attribution lives in this service's DB, not on the order record.** Three reasons: (1) this repo owns the conversations table, so extensions of `CHAT_SESSION#<ulid>` belong here by convention; (2) querying the ecommerce backend per metric would be a cross-service round trip on every dashboard render; (3) the order schema evolves for operational reasons (shipping, tax, disputes) that have nothing to do with AI, and coupling our analytics to that schema is a maintenance trap. Attribution is analytics data with its own lifecycle and its own home.
- **One record per payment, never accumulated.** Each completed payment = a fresh `PutItem` with its own unique `SK = ATTRIBUTION#<paymentIntentId>`. No read-then-write accumulation, no per-session aggregate records. If a single session converts twice, there are two attribution records with the same `PK` and different `SK`s. Reporting does the math at query time (`SUM(amount_cents) GROUP BY session_id`). Immutable, atomic, race-free.
- **Account-pointer record instead of a new GSI.** The "all revenue for account X this month" query is served by `Query PK=A#<accountUlid>, SK begins_with ATTRIBUTION#2026-04` — no GSI needed. This mirrors the session-pointer pattern already used in `identity.service.ts` for per-account session listings. Adds one extra `PutItem` per conversion in exchange for zero infrastructure work.
- **Write-first, read-later.** v1 intentionally ships no read endpoints. The data model and key patterns are designed now so a dashboard can be layered in later without a schema migration. Premature dashboard-building is the wrong place to spend time when the write path isn't even closed yet.
- **The ecommerce backend is the writer, not this service.** This repo emits the ULID into the URL and defines the record shape. All actual writes happen in the ecommerce repo's Stripe webhook handler. That's the cross-repo work still open (see Next).

**Next:**
- **Ecommerce backend extension (cross-repo, not done yet):** read `aiSessionId` off the checkout URL, persist it on the cart/order, pass it through to Stripe as `metadata.ai_session_id`, and in the payment-completed webhook handler write both `AttributionRecord` and `AttributionPointerRecord` into the conversations table. Until that lands, the URL param leaves this service but goes nowhere and no attribution records ever get written. This is the open loop.
- Analytics read endpoints on this service (e.g. `GET /chat/web/accounts/:accountUlid/attribution`) once there's enough data to query usefully.
- Refund handling: flip `status` to `"refunded"` on the matching attribution record when a refund webhook fires.
- Still queued separately: CSP `frame-ancestors` as the browser-enforced companion to the Referer gate. Deprioritized for v1 per the 2026-04-20 Referer entry.

---

## 2026-04-20 — Web chat: Referer-based embed authorization live end-to-end

**Goal:** Close the "an attacker copies the embed snippet onto evil.com" gap by enforcing a parent-page boundary at iframe load time. Before this, the account ULID in the embed snippet was all a third party needed to impersonate a legit customer.

**What changed:**
- New backend endpoint `POST /chat/web/embed/authorize` taking `{ accountUlid, parentDomain }` and returning `200 { authorized: boolean }` in both allow and deny cases (deny is not an error — the frontend needs boolean control flow, not exception handling).
- New `OriginAllowlistService.isOriginAuthorizedForAccount(accountUlid, parentDomain)` with its own `authorizationCache` map keyed by `${accountUlid}|${parentDomain}`. Same 5-min positive / 1-min negative TTL pattern as the origin and ULID caches, but isolated so keys can't collide.
- New `allowed_embed_origins?: string[]` field on the account DynamoDB document. Populated manually for v1 (`["localhost"]` on the test account); admin UI is a later task.
- Frontend (`/embed`) restructured into a Server Component that reads the HTTP `Referer` header via `next/headers`, calls the authorize endpoint server-to-server with a 3-second `AbortSignal` timeout, and branches between the widget and an error card. `useSearchParams` moved into a client subcomponent.
- Both sides fail closed — missing Referer, network error, timeout, or `authorized: false` all render the same error card.
- Verified end-to-end: backend logs show `Embed auth: resolved [authorized=true]` firing before the normal session-creation flow.

**Decisions worth remembering:**
- **Operator-typo normalization is backend's job.** The service normalizes both the incoming `parentDomain` and each entry in `allowed_embed_origins` at comparison time (trim + lowercase + strip scheme/port via `normalizeOrigin`). Operators paste raw strings into DynamoDB — "EXAMPLE.COM" and " shop.example.com " both match correctly. Explicit tests lock this in. Don't push normalization onto the operator; they'll get it wrong.
- **`extractStringArray` filters non-string entries at the DB boundary** (`.filter((v): v is string => typeof v === "string")`). If someone ever writes a mixed-type array, `normalizeOrigin(42)` would throw inside `.some()` and reject the whole account. One-line filter closes that gap without defensive try/catch everywhere downstream.
- **200 on deny, not 4xx.** Deny is a valid control-flow outcome for the frontend, not an exception. A `ForbiddenException` would have forced error-handling code paths around what should just be a boolean branch.
- **Referer reading must happen server-side** (Server Component or route handler). Flagged this to the frontend orchestrator up front — without it, their planner would have tried to read `document.referrer` client-side, which isn't the same guarantee and misses the initial iframe-load request where the real HTTP Referer is set.

**Next:**
- **CSP `frame-ancestors`** — the browser-enforced layer that pairs with Referer. Reads the same `allowed_embed_origins` array, emits a header on the `/embed` response so the browser itself refuses to render the iframe on unapproved parents. Backend exposes a way to fetch the list (or we inline it during SSR); frontend sets the header. Roughly 30% of the remaining embed-attack surface.
- Admin surface to populate `allowed_embed_origins` per account (manual DynamoDB edits don't scale).
- Rate-limit the authorize endpoint (currently unauthenticated; low risk, but worth budgeting).
- Cache-bust hook so newly added domains don't wait up to 5 minutes for the positive-TTL window to expire.

---

## 2026-04-20 — Web chat: server-authoritative onboarding + history hydration

**Goal:** Upgrade web chat sessions to be server-authoritative for onboarding state (splash completion + budget) and hydratable for returning visitors. Drops the "auto-send budget as an opening user message" hack in favor of structured fields on the session METADATA record, and gives the agent budget context via an uncached second system block so the 2,734-token static prefix keeps cache-hitting.

**What changed:**
- `ChatSessionMetadataRecord` gains `onboarding_completed_at?: string` and `budget_cents?: number`. On the wire, the same values are surfaced as `onboardingCompletedAt: string | null` and `budgetCents: number | null`.
- `POST /chat/web/sessions` response now includes the onboarding fields. For a new session both are `null`; for a returning session (existing identity pointer) `IdentityService.lookupOrCreateSession` does a second `GetItem` on the METADATA record and echoes the stored values.
- New `POST /chat/web/sessions/:sessionUlid/onboarding` with body `{ budgetCents }` (positive integer, $1M cap). Maps `ConditionalCheckFailedException` from the `attribute_exists(PK)` guard to 404.
- New `GET /chat/web/sessions/:sessionUlid/messages` returns `{ messages: [{ id, role, content, timestamp }] }` — filters out user records whose content is only `tool_result` blocks and assistant records that carry only `tool_use` blocks. Tool-loop scaffolding stays on the backend; the UI only sees real user/assistant text.
- `AnthropicService.sendMessage` accepts an optional fourth `dynamicSystemContext` argument and appends it as a **second, uncached** `TextBlockParam`. The first block keeps `cache_control`, so the static prefix still hits the 5-minute prompt cache and the per-session budget note only costs ~1 extra input token per call.
- `ChatSessionService.handleMessage` reads `budget_cents` off METADATA and passes `"User context: shopping budget is approximately $X."` into the new arg. Verified end-to-end: the first call after onboarding shows `cacheCreate=2734` (static prefix cached) with `input_tokens` one higher than the no-budget baseline.

**Decisions worth remembering:**
- **Cents everywhere, not dollars.** `budgetCents` on the wire and `budget_cents` in DynamoDB. Integer math from the browser input through the DB. No float edge cases possible; matches Affirm's convention; converting at the boundary was the less-clean option we considered and rejected.
- **`onboardingCompletedAt: string | null`, not a boolean.** Same `!!` semantics at the edge, free analytics (when did each visitor splash), and lets us add an expiry window later without a schema change. Zero added complexity on the frontend.
- **Budget goes in a second system block, not by extending the cached prefix.** The 2026-04-19 A/B test showed the ~90% cost reduction hinges on the 2,734-token static prefix cache-hitting. Concatenating the budget into the cached prompt would've broken that per-session. Second block keeps the cache intact and is the standard Anthropic pattern for this.
- **Tool-use/tool-result blocks stay server-side.** `getHistoryForClient` filters them out; the UI only sees user + assistant text. Keeps the ChatPanel hydration dumb and the stored message log complete.

**Next:**
- Still queued from the prior plan: `allowedEmbedOrigins: string[]` on accounts + `Referer` check on `/embed` initial load + `Content-Security-Policy: frame-ancestors`. That's the actual parent-page enforcement layer.
- Optional: backend-generated welcome turn on onboarding so returning-visitor-like warmth lands on first paint for new visitors too. Static empty-state ("What are you shopping for today?") is fine for v1; revisit if conversion on the empty state is weak.

---

## 2026-04-19 — Web chat: swap `hostDomain` for `accountUlid` on session create

**Goal:** Stop resolving the account from a GSI1 `DOMAIN#<host>` query on session create and start resolving it directly from an `accountUlid` sent in the body. Sets us up to authorize the widget on domains beyond the customer's primary ecommerce store without duplicating GSI entries.

**What changed:**
- Frontend snippet now carries the account ULID as `data-account-ulid="A#<ulid>"`. Widget reads it, passes it through the iframe URL, and includes it in the `POST /chat/web/sessions` body. `hostDomain` removed from the wire entirely.
- Backend validation schema drops `hostDomain`, adds `accountUlid` as required (`^A#[0-9A-HJKMNP-TV-Z]{26}$`).
- New `OriginAllowlistService.verifyAccountActive(ulid)` — direct `GetItem` on `{ PK: A#<ulid>, SK: A#<ulid> }`, with a separate `ulidCache` using the same 5-min positive / 1-min negative TTL pattern as the origin cache.
- `WebChatController.createSession` no longer reads the `Origin` header or `body.hostDomain`; strips the `A#` prefix and calls `verifyAccountActive` instead.
- Verified end-to-end with a Playwright user-flow run (3 user turns in a real conversation). Backend logs confirmed `Account check: resolved [accountUlid=…]` and `Session created [… source=accountUlid]` on every session create.

**Decisions worth remembering:**
- Kept the `A#` prefix on the wire (frontend sends `A#<ulid>`, backend strips before lookup). Customers copy-paste whatever we tell them to, so the extra two chars cost nothing and keeps the embed string visually distinct from session/guest ULIDs.
- Did *not* add an `allowedEmbedOrigins` array on the account doc yet. Chose to keep this PR minimal and ship the follow-up in a separate change with Referer + CSP `frame-ancestors`, which together are the real parent-page boundary. Neither `hostDomain` (before) nor `accountUlid` (now) is a real security boundary — both are spoofable body fields. The lookup change is purely an efficiency + flexibility swap.
- Left the CORS-layer Origin allowlist in `main.ts` untouched. It's a different layer and still serves a purpose.

**Next:**
- Follow-up PR: add `allowedEmbedOrigins: string[]` on account docs + Referer validation on `/embed` initial load + CSP `frame-ancestors` set from the approved list. That's the actual parent-page enforcement.

---

## 2026-04-19 — Empirical A/B test: prompt caching + Sonnet switch deliver ~90% cost reduction

**Goal:** Validate under real Playwright-driven traffic that the prompt caching + model switch shipped on 2026-04-16 (commit `5d2da46b`) actually deliver the expected cost savings. Spun out of a "$5 of API credits lasted 8 days" observation — wanted receipts, not estimates.

**What we did:**
- Temporarily disabled caching (removed the `cache_control` marker — in-memory only, never committed). Ran a 3-message Playwright conversation. Captured the 4 Anthropic debug-log lines as baseline (Test A).
- Re-enabled caching to match the shipped state. Ran an identical 3-message Playwright conversation with a fresh guest/session (`localStorage` cleared). Captured 4 debug-log lines (Test B).
- Compared per-call `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` using the debug log line added in `5d2da46b`.

**What we confirmed:**
- Static prefix (shopping_assistant's system prompt + 3 tool schemas) is exactly **2,734 tokens**.
- Call 1 of a fresh conversation writes the cache (cacheCreate=2734, one-time 1.25× premium ≈ $0.002 on Sonnet 4.6 pricing).
- Calls 2+ within the 5-minute TTL hit cleanly — `cacheRead=2734` on every subsequent call, identical byte-for-byte.
- **Caching alone** (holding Sonnet constant): **44% cost reduction** on the 4-call test conversation. Extrapolates to ~65–70% on a typical 10-turn conversation as the one-time write premium amortizes across more reads.
- **Combined stack vs pre-2026-04-16 baseline** (Opus 4.6 + no caching): **~90% per-conversation cost reduction.** The $5 credit spend that used to last ~8 days now projects to last ~8 weeks at the same traffic.
- Cache is model-scoped — the Sonnet cache is independent; switching from Opus invalidated the old cache but Sonnet built its own cleanly from turn 1.

**Decisions worth remembering:**
- **Break-even for the cache-write premium is exactly 2 calls per conversation.** Every realistic conversation clears it comfortably, so caching is always a net win — no length threshold to worry about.
- **The `[AnthropicService] Anthropic response [input=X output=Y cacheRead=Z cacheCreate=W]` debug log is the only non-billing-side way to spot silent cache invalidators.** If someone accidentally interpolates a timestamp, session ID, or other dynamic content into the system prompt in the future, `cacheRead` will drop to 0 across requests with no other symptom. Keep that log line in production.
- **`input_tokens` in the API response is the UNCACHED remainder only.** Full tokens processed per call = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Tripped me up reading Test B numbers initially — worth a mental note for future cost audits.
- **Per-conversation dollar cost at current shipping stack** (Sonnet 4.6 + cache, 3-message chat): ~$0.026. A typical 10-turn shopping flow should land around $0.05–$0.09. Multiply by projected traffic to model monthly cost.

**Next:**
- No code changes — the 2026-04-16 implementation is correct and empirically validated.
- Optional future optimization: adding a second `cache_control` breakpoint on the second-to-last message would also cache conversation history, squeezing another ~10–15% for long conversations (20+ turns). Not worth doing until real user telemetry shows long conversations are common.
- CSS/UX polish on the widget iframe is still the next logical deliverable per the 2026-04-16 queue.

---

## 2026-04-16 — M3 shipped + iframe-origin deploy-blocker fix

**Goal:** Ship the browser-side half of the chat stack (a Next.js widget project deployed to `chat.instapaytient.com` in its own repo) and resolve the iframe-origin/CORS gap that would have silently broken production on first deploy.

**What changed in this repo:**
- `POST /chat/web/sessions` now accepts an optional `hostDomain` body field. When present, it is used for account resolution instead of the browser's `Origin` header. Solves the fundamental browser-security constraint that iframe JavaScript gets the iframe's own origin on `fetch()` calls, never the parent page's — so the parent's domain has to flow through as data, not via the Origin header.
- New env var `WEB_CHAT_WIDGET_ORIGINS` — comma-separated list of trusted widget deployment origins (`https://chat.instapaytient.com` in prod, `http://localhost:3000` in dev). Bypasses the GSI-based customer-practice allowlist at CORS-check time because the widget's own origin isn't and never will be a practice domain.
- `OriginAllowlistService.normalizeOrigin` made permissive — accepts both full origins (`http://localhost:3000`) and bare hostnames (`localhost`, `shop.example.com`). Prepending `https://` when no scheme is present lets one code path serve both CORS middleware (full Origin) and the controller's hostDomain-based lookup (bare host). Previously threw on bare hostnames, which is how the iframe/widget integration manifested as a 500.
- 6 new specs across the controller and allowlist service covering the new paths.
- Suite: 12 suites / 153 tests passing (up from 148 pre-session).

**What was built in the widget repo (separate codebase, noted for the record):**
- Next.js 15 App Router + HeroUI v3 + Tailwind v4 scaffold.
- `/embed` route — the iframe chat UI, consuming the existing `/chat/web/*` endpoints. Markdown-sanitized rendering with automatic checkout-URL detection that renders a prominent "Open checkout" CTA.
- `/widget.js` route handler — serves a vanilla-JS embed script (~2 KB gzipped) with a single `<script>` tag integration. Reads `document.currentScript.src` to derive its own origin at runtime so dev and prod both work without config. Mints/persists the client-side guest ULID, reads `window.location.hostname` from the parent page, passes both to the iframe as query params.
- Iframe `createSession` call includes `hostDomain` in the body, completing the round-trip.
- 24/24 tests pass, production build clean, full end-to-end live-validated via a local sandbox HTML page served from a throwaway `python3 -m http.server`.

**Decisions worth remembering:**
- **The Origin header is browser-stamped and immutable.** An iframe's fetch always carries the iframe's origin, never the parent page's. This is a security feature of the web, not a bug. Any widget that needs to know the host page's domain MUST pass it as data — URL param, body field, or header. Industry standard: every mature widget (Intercom, Stripe, Drift, etc.) does this via `data-*` attributes or `window.xxx = {...}` config objects.
- **Two separate concerns, two separate mechanisms.** CORS trusts the widget's own deployment origin. Account resolution uses the body's `hostDomain` to find the right practice. Keeping these split is simpler than trying to conflate them through a single GSI lookup keyed on whatever origin shape the browser happened to send.
- **Do NOT dual-write to the abandoned-cart table from the agent.** Considered having `create_guest_cart` write an abandoned-cart record to trigger the store's existing recovery flow; rejected. "Abandoned cart" is a specific business concept (user walked away from checkout) and polluting that table would corrupt analytics, misfire recovery emails, and distort retargeting. Better to teach the front-end middleware a new URL-param path than to lie about the data. The `?guestId=...&cartId=...` URL contract is what the middleware now reads to bypass cookie-minting and load our pre-written guest cart.
- **Accept HeroUI's 181 KB iframe bundle cost.** Industry peer widgets (Intercom, Drift, Zendesk) are 300–400 KB+ and load on page load, not lazily. Ours is below average for the category AND loads on-demand after a user clicks the bubble — so it never touches the host page's Lighthouse score. Premature optimization here costs tested accessibility and consistency with the future admin dashboard (which will also be HeroUI). Revisit only if real user telemetry shows sluggishness.
- **Bare-hostname parsing is a widening, not a breakage.** `normalizeOrigin` now accepts both `http://host:port` and bare `host` shapes, normalizing both to the same GSI key. Forgiving to any caller; no behavior regression for CORS middleware's full-origin inputs.

**Next:**
- **CSS / UX polish** on the iframe — positioning, bubble visual, shadows, spacing. Tailwind tweaks only, no HeroUI swap.
- **Deploy infrastructure** — Vercel project for `chat.instapaytient.com`, DNS, prod `NEXT_PUBLIC_CHAT_API_URL`, set `WEB_CHAT_WIDGET_ORIGINS=https://chat.instapaytient.com` on the backend, onboard the first pilot practice's domain record in the accounts table.
- **Hardening follow-up (flagged at M1):** scope `externalId` by origin in the web controller (`externalId = "<host>:<guestUlid>"`) to close the cross-origin session-hijack edge case. One-line change.
- **Cleanup nit (flagged at M1):** `chat-session.service.ts` line 247 still passes a raw error object to `logger.error` instead of `error.name`. Pre-existing, still deferred.

---

## 2026-04-15 — M2: Guest cart creation + checkout URL handoff

**Goal:** Ship the final link of the shopping_assistant flow — after the visitor commits to one or more services, the agent writes a guest cart to DynamoDB (looking up or creating the underlying customer record in the process), constructs a checkout URL that the Instapaytient front-end can load directly into step two, and presents it to the visitor as a clickable link.

**What changed:**
- New `create_guest_cart` tool — full 11-step flow: load contact info from session's `USER_CONTACT_INFO` record, look up existing customer by GSI1 on `(ACCOUNT#<account>, EMAIL#<email>)` or create one with conditional-put race recovery, `BatchGetItem` the selected services, resolve variant options, write the guest cart (`SK = G#<guestUlid>C#<cartUlid>`, NO `entity` attribute per the sample shape), resolve the checkout base URL (from `CHECKOUT_BASE_URL_OVERRIDE` env var or the account's GSI1-PK domain), return a structured JSON result with the URL.
- Additive M1 extension — `TrimmedVariant` and `TrimmedVariantOption` now surface `variant_id` and `option_id` so the agent can pass them back when committing a cart.
- `shopping_assistant` system prompt extended — WORKFLOW step 6 and PURPOSE step 6 now direct the agent to call `create_guest_cart` after the closing transition line and present the returned URL as the final message. `allowedToolNames` grows to three.
- New env var `CHECKOUT_BASE_URL_OVERRIDE` — optional URL used in place of the account's production domain for local dev checkout testing.
- Checkout URL includes `guestId` and `cartId` query params so the e-commerce front-end middleware can set them as cookies directly and bypass its default cart-minting path, letting the checkout page find the cart we just wrote.
- `list_services` debug log enriched with `rawCount / filteredCount / finalCount` — makes zero-result diagnosis instant (query returned nothing vs everything filtered out by flags vs hard-capped at 50).
- Test suite now 12 suites / 142 tests passing (baseline: 11 / 114).

**Decisions worth remembering:**
- **Do NOT write abandoned-cart records from the agent.** "Abandoned cart" is a specific business concept (user walked away from checkout) and polluting that table with agent-initiated carts would corrupt abandoned-cart analytics, misfire recovery emails, and distort retargeting. When live testing revealed the front-end redirected to `/shop` on our newly-written guest cart, the fix is on the e-commerce side (new middleware branch reading `guestId`/`cartId` URL params and setting cookies directly), NOT in this API where a dual-write would have been semantically wrong.
- **`guestId` + `cartId` in the URL is the iframe handoff contract.** The front-end middleware contract is now: when both are present, skip default cookie minting and set them from the URL. Both are Crockford base32 ULIDs so no URL-encoding required.
- **Contact info for `create_guest_cart` is read from `USER_CONTACT_INFO`, not from tool input.** DynamoDB is the source of truth; the agent cannot hallucinate or typo values into the cart. One extra `GetItem` is worth it.
- **Customer lookup-or-create uses conditional put with single-retry race recovery.** `attribute_not_exists(PK)` on the write; on `ConditionalCheckFailedException`, re-query GSI1 once to get the winner's ULID. No retry loop.
- **Sales tax is always zero.** Instapaytient is flat-fee — the guest cart writes NO `tax`, `sub_total`, or `total` fields. Totals are computed at real checkout time.

**Next:**
- M3 — scope the production iframe UI. Embedded script tag + chat widget that posts to `/chat/web/sessions` and `/chat/web/messages` with a client-minted `guestUlid`, renders agent replies, and opens the returned checkout URL in a new tab. Front-end work, not core API — M3 planning should decide whether the iframe lives in this repo or in the e-commerce store.
- Follow-up (pre-M3) — scope `externalId` in the web controller by origin host (`externalId = "<host>:<guestUlid>"`) to close the cross-origin session-hijack edge case flagged in M1. One-line change.
- Follow-up — `chat-session.service.ts:247` still passes a raw error object to `logger.error` instead of `error.name`. Pre-existing, flagged by M1 code review, still deferred.
- Nit — `toRecordArray` / `toNativeArray` helpers are duplicated across `list-services.tool.ts` and `create-guest-cart.tool.ts`. Extract to `src/utils/` in a future cleanup commit.

---

## 2026-04-14 — M1: Shopping Assistant agent + account-bound sessions

**Goal:** Ship a service-discovery agent that runs on the M0 web chat iframe channel — greets visitors on a client's practice website, pulls the practice's service catalog from DynamoDB, recommends matching services, and softly collects contact info before handing off to the (future) M2 cart + checkout flow.

**What changed:**
- New `shopping_assistant` agent — pure config, seven-step WORKFLOW covering greeting with Affirm social proof, discovery, catalog lookup, recommendation, contact capture, closing transition, and an explicit empty-catalog fallback. Allowed tools: `list_services` and (reused from `lead_capture`) `collect_contact_info`.
- New `list_services` tool — zero-argument lookup that reads `accountUlid` from the tool execution context, runs a targeted `Query` on `PK = A#<accountUlid>, begins_with(SK, "S#")`, post-filters to `enabled && is_shown_in_shop`, sorts featured-first then alphabetical, hard-caps at 50, and returns an aggressively trimmed shape (no images, no stock, no timestamps, no GSI attributes, description truncated to 400 chars, prices converted to USD).
- `OriginAllowlistService` refactor: public API changed from `isAllowed(origin): Promise<boolean>` to `resolveAccountForOrigin(origin): Promise<string | null>`. Cache entry shape reshaped to store the resolved ULID (or null for denials). All M0 invariants preserved — `status.is_active` gate, `GSI1-PK` hyphen aliasing, fail-closed-no-cache on DynamoDB error.
- `IdentityService.lookupOrCreateSession` signature extended with optional `accountUlid?: string`. Persisted on create path only, never overwritten on lookup. Discord and email-reply callers unaffected.
- `ChatToolExecutionContext` extended with optional `accountUlid?: string`. `ChatSessionService` loads it from session metadata and threads it into every tool dispatch.
- `WebChatController.POST /chat/web/sessions` now resolves the account from the `Origin` header via the existing same-request allowlist cache — zero extra DynamoDB roundtrips. Uses `@Headers('origin')` for a cleaner signature than `@Req()`.
- Suite now 11 suites / 114 tests passing (baseline: 9 / 80). `tsc --noEmit` clean.

**Decisions worth remembering:**
- **Account binding lives on the session, not on the message.** Once a session is created, its `accountUlid` is immutable. M2's cart and checkout tools get tenancy for free — just read `context.accountUlid`, no re-resolution from headers needed.
- **`OriginAllowlistService` was always going to return more than a boolean.** The M0 version was intentional YAGNI, but the GSI query always fetched the full account item — collapsing to `boolean` was premature pessimization. M1's refactor is the shape the service should have had if we'd known M1 was next.
- **Race-losing sessions do NOT retroactively patch `accountUlid`.** Realistic racers share an origin and therefore an account, so the winner's record is correct for all racers. A theoretical cross-origin hijack (different origins racing the same client-minted `guestUlid`) remains a pre-existing M0 concern — not an M1 regression. Follow-up idea: scope `externalId` by origin in the web controller (`externalId = "<host>:<guestUlid>"`) to make cross-origin collisions impossible.
- **`list_services` ships with zero input parameters.** The tool is a "show me everything for my session's account" lookup and the agent reasons over the catalog in context. If the agent gets lazy about featured items or ignores relevant services in live testing, we add a filter. Shipping with zero params first means we see real behavior before adding surface area.
- **Hard-cap of 50 is enforced in TypeScript, not via DynamoDB `Limit`.** `Limit` applies before `FilterExpression` and would under-fetch when services are disabled. Cap after filtering.

**Next:**
- M2 — guest cart creation (`create_guest_cart` tool writing to `PK = A#<accountUlid>, SK = G#<guestId>C#<cartId>`) + checkout URL generation for the Affirm front-end modal handoff. The M1 closing transition line ("I'm getting your selection ready and pulling together a checkout link") is the natural seam.
- Follow-up: scope `externalId` by origin in the web controller to close the cross-origin hijack edge case. One-line change, worth doing before M2 cart writes go live.
- Follow-up: `chat-session.service.ts:247` passes a raw error object to `logger.error` — flagged by M1 code review as inconsistent with the "error.name only" convention. Pre-existing, not an M1 regression, worth a separate cleanup pass.

---

## 2026-04-14 — M0: Web chat iframe channel

**Goal:** Build the backend HTTP channel that lets browser iframes embedded on client websites talk to the existing agent framework, so future financing / pre-qualification / service-recommendation agents have a reusable web entry point.

**What changed:**
- `WebChatController` with `POST /chat/web/sessions` and `POST /chat/web/messages`. Thin orchestration over `IdentityService` and `ChatSessionService`, mirroring the Discord pattern.
- `OriginAllowlistService` — dynamic CORS backed by a targeted GSI1 `Query` against the single Instapaytient accounts table, with an in-memory per-origin TTL cache (5 min positive / 1 min negative).
- `main.ts` wired to NestJS `enableCors` via an async origin callback, resolved from the DI container before registration.
- `WEB_CHAT_CORS_ALLOW_ALL` dev escape hatch with a root-level `superRefine` on the env schema that refuses to boot when set to `true` under `APP_ENV=prod`.
- `ChatAgent.displayName` added as an optional additive field; `lead_capture` sets it to `"Lead Capture Assistant"`. Suite now 9 suites / 80 tests passing (up from 77).

**Decisions worth remembering:**
- **Targeted GSI query, not preload-and-scan.** Accounts already have `GSI1-PK` on `DOMAIN#<host>` — an O(1) cold-cache lookup is strictly better than scanning every account at startup. The older Instapage scan-and-array pattern was legacy and deliberately not carried forward. Fresher, cheaper, no memory bloat.
- **Hyphenated attribute forces `ExpressionAttributeNames` aliasing.** The real attribute is `GSI1-PK` — dashes are parsed as subtraction in raw `KeyConditionExpression` strings, so every GSI query must alias via `"#gsi1pk": "GSI1-PK"`. Nearly slipped past the plan; caught by verifying against a real account document before launching the implementer.
- **`status.is_active` gate is mandatory.** Origins are only allowed when the matched account has `status.is_active === true`. Suspended clients' iframes stop working automatically on the next cache expiry — no manual cleanup required. Validated in service code rather than as a nested DynamoDB `FilterExpression`, for auditability.
- **Fail closed on DynamoDB errors, don't cache the failure.** Transient GSI errors must not wedge legitimate origins until TTL expiry. Return `false`, skip the cache write, let the next request retry.
- **`ChatAgent.displayName` is additive, not a rename.** `name` was already serving as the unique snake_case ID across Identity, session metadata, and Discord wiring. Renaming would have ballooned M0 into a cross-cutting refactor for zero user-visible benefit.

**Next:**
- M1 — Affirm pre-qualification agent with `start_prequalification` / `check_prequal_status` tools. Uses this web channel.
- M2 — service-recommendation tool that queries the related service records under each account and filters by the M1 approved amount.
- M3 — cart + pre-filled checkout handoff to `instapaytient.com` step 2 (bypassing step 1 since we collect contact info in the agent).
- Follow-ups: Crockford ULID validation isn't exercised end-to-end through the controller pipe (spec fixtures bypass it — worth a thin integration test); `DYNAMODB_TABLE_CONVERSATIONS` env var name is misleading now that the table is the whole single-table model — rename in a separate cleanup pass.

---

## 2026-04-13 — Reference documentation suite

**Goal:** Create project-level reference docs describing what the system is and does today, distinct from the existing how-to guides.

**What changed:**
- Added `docs/README.md` as a hub splitting docs into Reference (what the system is) and Agent/engineering (how to work on it).
- Added `docs/reference/architecture.md` — layered diagram, request lifecycle, key design decisions, file map.
- Added `docs/reference/concepts.md` — glossary of session, identity, channel, agent, tool, tool-use loop, content block.
- Added `docs/reference/data-model.md` — DynamoDB single-table layout, all PK/SK patterns, access patterns.
- Added `docs/reference/agents-and-tools.md` — catalog of the `lead_capture` agent and all three tools as they ship today.
- Added `docs/reference/channels/discord.md` and `docs/reference/channels/email.md` — channel adapter reference including DNS/SendGrid setup for the inbound reply loop.
- Added `docs/reference/operations.md` — env var table, local run, logging, security notes.

**Decisions worth remembering:**
- Picked a multi-file structure over a single `ARCHITECTURE.md`. Rationale: the project already has multiple channels and agents and is growing. Granular files age better and let future Twilio SMS/voice additions slot in cleanly as `channels/sms.md` / `channels/voice.md` without restructuring.
- Reference docs live under `docs/reference/`, how-to guides stay under `docs/agent/engineering/`. Clean split between "what the system is" vs. "how to work on it".
- This journal was chosen over a `YYYY-MM-DD/` folder structure. Reasoning: dated folders rot fast, a new agent only reads the most recent one or two entries anyway, and a single rolling file avoids filesystem sprawl while staying portable across tools (readable by humans, reviewable in PRs, not tied to any specific AI harness's memory system).

**Next:**
- No concrete follow-ups. The reference docs are now the authoritative snapshot of the system; update them as code evolves.
- When Twilio SMS or voice is built, add `docs/reference/channels/sms.md` / `voice.md` and update `concepts.md` (source list) and `operations.md` (env vars).

---

## (earlier, undated) — Foundation → v1 channel-agnostic platform

**Goal:** Build an agentic AI chat backend with persistent memory, tool execution, and multi-channel support where adding a new channel or agent never requires touching the core services.

**What changed:**
- Built the core tool-use loop in `ChatSessionService` — loads history from DynamoDB, calls Anthropic, executes tool calls, persists results, bounded at 10 iterations as a safety valve.
- Introduced structured content blocks (`text`, `tool_use`, `tool_result`) stored as JSON in DynamoDB, matching the Anthropic SDK shape so no translation layer is needed.
- Built `IdentityService` with `(source, externalId, agentName) → sessionUlid` lookup/create semantics and conditional writes for race-safety.
- Built `AgentRegistryService` and `ToolRegistryService` with decorator-based auto-discovery (`@ChatAgentProvider()`, `@ChatToolProvider()`) via NestJS `DiscoveryService`. Adding an agent or tool is one `providers: [...]` entry in `AppModule`.
- Defined the `ChatAgent` interface (`name`, `description`, `systemPrompt`, `allowedToolNames`) — agents are pure config, zero orchestration code.
- Shipped the `lead_capture` agent with a locked 5-field collection workflow, verification step, correction flow, and HTML confirmation email template. System prompt was refined through live testing (tone, emoji usage, boundary handling, jailbreak resistance).
- Shipped three tools: `collect_contact_info` (incremental DynamoDB upserts), `send_email` (SendGrid), `save_user_fact` (long-term key/value memory, not yet wired back into prompt context).
- Wired Discord as a channel adapter (`DiscordService`) including a raw-gateway workaround for a `discord.js` v14.26.2 DM bug.
- Built the email reply loop: outbound encodes `<sessionUlid>@<replyDomain>` in the From address; inbound via SendGrid Inbound Parse webhook routes back to the same session via `EmailReplyService` with sender validation, message-ID dedupe, and threaded replies.
- Added `SENDGRID_REPLY_DOMAIN` env var with domain validation, enabling per-client reply domains without core changes.
- Wrote the how-to guide `docs/agent/engineering/creating-agents-and-tools.md` covering the 3-step process for new engineers adding agents or tools.

**Decisions worth remembering:**
- Tool allowlists are enforced in **two** places: (a) tools not in the allowlist are filtered out of the list sent to Anthropic so the model never sees them, and (b) a defense-in-depth check inside the tool-use loop re-validates before dispatch. A jailbroken prompt cannot route around either layer.
- Agents hold zero orchestration code. The core `ChatSessionService` is generic and loads the agent from session metadata at request time. This is what makes adding agents a zero-core-change operation.
- Session ULID encoded in the outbound email sender's local part is the routing key for inbound replies — no database lookup required to figure out which session a reply belongs to. This is also what enables per-client reply domains cleanly.
- Single-table DynamoDB with session-ULID-prefixed PKs means reading full session state is one `Query`, not a fan-out. No GSIs yet; add them when a non-session access pattern actually appears.
- `start:local` (not `start:dev`) is the canonical local-run command. Documented in `CLAUDE.md`.

**Next:**
- Twilio SMS adapter as a new channel.
- Twilio Voice adapter (real-time transcription → chat core → TTS reply).
- Surface `USER_FACT#<key>` records back into the agent's prompt context at conversation start.
- Observability: metrics for tool loop iterations, Anthropic latency, inbound email outcomes.

---
