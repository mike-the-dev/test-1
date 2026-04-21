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
