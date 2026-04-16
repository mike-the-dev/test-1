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
