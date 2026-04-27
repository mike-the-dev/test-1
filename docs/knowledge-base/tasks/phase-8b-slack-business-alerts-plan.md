# Phase 8b — Slack Business-Signal Alerts: Implementation Plan

---

## Overview

This phase wires a new `SlackAlertService` into three high-signal moments of the shopping-assistant flow — conversation started, cart created, and checkout link generated — so the team sees real-time business activity in `#instapaytient-agentic-ai-alerts` without polling dashboards or Sentry. The service is a thin HTTP-posting wrapper that no-ops gracefully when `SLACK_WEBHOOK_URL` is unset, catches and forwards all Slack-side failures to Sentry without ever blocking the calling business logic, and exposes exactly three typed methods. All three injection sites call those methods as a fire-and-forget side effect after their success paths. Because `IdentityService.lookupOrCreateSession()` does not currently return a "was this newly created" signal, a minimal return-type addition is required before the conversation-started alert can safely gate on new sessions only.

---

## Affected Files and Modules

### Create
- `src/services/slack-alert.service.ts` — the core service: three typed alert methods, HTTP client using native fetch, no-op gate, fire-and-forget failure handling with Sentry forwarding
- `src/services/slack-alert.service.spec.ts` — unit tests covering all three methods across no-op, success, HTTP failure, and abort-timeout paths
- `src/services/slack-alert-config.service.ts` — typed config accessor for `SLACK_WEBHOOK_URL`, mirroring `AnthropicConfigService`
- `src/services/slack-alert-config.service.spec.ts` — minimal spec confirming the getter delegates to `ConfigService`

### Modify
- `src/services/identity.service.ts` — extend the `lookupOrCreateSession()` return type to include `wasCreated: boolean`; set `true` on the create path, `false` on the resume path (including the race-condition recovery branch)
- `src/services/identity.service.spec.ts` — add two assertions: `wasCreated: true` on new session, `wasCreated: false` on resumed session
- `src/config/env.schema.ts` — add `SLACK_WEBHOOK_URL: z.string().url().optional()`
- `src/config/configuration.ts` — add `slack: { webhookUrl: process.env.SLACK_WEBHOOK_URL }` namespace
- `src/app.module.ts` — add `SlackAlertConfigService` and `SlackAlertService` to the providers array
- `src/controllers/web-chat.controller.ts` — inject `SlackAlertService`; after successful `lookupOrCreateSession()`, fire the conversation-started alert if `wasCreated === true`
- `src/tools/preview-cart.tool.ts` — inject `SlackAlertService`; after the success path at Step 12, fire the cart-created alert when `itemCount > 0`
- `src/tools/generate-checkout-link.tool.ts` — inject `SlackAlertService`; after Step 6 (URL construction), fire the checkout-link alert

### Review Only
- `src/types/Sentry.ts` — confirm `SentryCaptureContext` shape; no changes needed
- `src/types/Tool.ts` — confirm `ChatToolExecutionContext` shape; no changes needed

---

## Slack Webhook Verification Findings

Sources:
- Webhook contract: https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks
- Block reference: https://docs.slack.dev/reference/block-kit/blocks
- Button element: https://docs.slack.dev/reference/block-kit/block-elements/button-element

**Confirmed contract:**
- Method: `POST` to the webhook URL (e.g., `https://hooks.slack.com/services/T.../B.../xxx`)
- Content-Type: `application/json`
- Success response: HTTP `200 OK` with body `ok` (plain text)
- Failure responses:
  - `400 Bad Request` — malformed JSON or missing required fields (e.g., `no_text` error when neither `text` nor `blocks` with content is provided)
  - `403 Forbidden` — revoked or invalid webhook token
  - `404 Not Found` — webhook URL does not exist
  - `410 Gone` — channel archived or webhook explicitly deleted
- Rate limit behavior: Slack does not publish an explicit numeric rate limit for incoming webhooks in documentation; the documented behavior is that excessive posting to a channel will result in `too_many_requests` (HTTP 429) responses. The 5-second abort timeout handles hung connections regardless.
- Important: You cannot override channel, username, or icon — those are set at app installation time.
- The `blocks` array replaces or augments the `text` field. Best practice is to always include `text` as a fallback for notification previews even when using blocks.
- `header` block: `type: "header"`, `text.type` must be `"plain_text"` (max 150 chars)
- `section` block: `type: "section"`, optional `fields` array of up to 10 text objects (mrkdwn or plain_text), max 2000 chars per field
- `divider` block: `{ "type": "divider" }` — no fields needed
- `actions` block with URL button: button element uses `"url"` field (max 3000 chars) to open a link in the browser

---

## `SlackAlertConfigService` Design

File: `src/services/slack-alert-config.service.ts`

Mirrors `AnthropicConfigService` exactly. The only getter is `webhookUrl`.

```typescript
@Injectable()
export class SlackAlertConfigService {
  constructor(private readonly configService: ConfigService) {}

  get webhookUrl(): string | undefined {
    return this.configService.get<string>("slack.webhookUrl", { infer: true });
  }
}
```

---

## `SlackAlertService` Design

File: `src/services/slack-alert.service.ts`

### Structural decisions

**No-op gate:** The service reads `webhookUrl` once at construction time and stores it as `private readonly webhookUrl: string | undefined`. If undefined, the constructor logs once at `Logger.log` level: `[action=slack_alerts_disabled reason=SLACK_WEBHOOK_URL_not_configured]`. Every public method returns immediately if `webhookUrl` is undefined — no per-call logging.

**Fire-and-forget model (see key decisions):** Each public method is `async` and internally calls a private `postToSlack()` helper. The public methods do NOT perform fire-and-forget internally — instead, the callers call the method as a non-awaited expression with a chained `.catch()`. This means: `this.slackAlertService.notifyConversationStarted(...).catch(() => undefined)`. The method itself is awaitable; it is the call site that chooses not to await. Rationale: keeping the methods fully `async` makes them unit-testable by awaiting them in tests, while the `.catch()` at the call site is the single explicit record that "we are knowingly not blocking here."

**HTTP failure handling:** A private `sendRequest()` helper wraps the `fetch` call. Any non-2xx response is treated as an error (reads the response body for logging context, but never logs the webhook URL). Network errors and `AbortError` (from the 5-second timeout) are also caught here. All failures are logged with `[errorType=... category=slack alertType=...]` and forwarded to `this.sentryService.captureException(error, { tags: { category: "slack", alert_type: "..." } })`. The error is never re-thrown out of the public method.

**Block-building helpers:** Three private methods — `buildConversationStartedBlocks()`, `buildCartCreatedBlocks()`, `buildCheckoutLinkBlocks()` — each return the blocks array. These are not exported. The `text` field (Slack's notification fallback) is always included in the top-level POST body alongside `blocks`.

### Class shape (pseudocode — not production code)

```
SlackAlertService
  - logger: Logger
  - webhookUrl: string | undefined  (set at construction; never logged)

  constructor(slackAlertConfigService, sentryService)
    webhookUrl = slackAlertConfigService.webhookUrl
    if !webhookUrl: logger.log("[action=slack_alerts_disabled reason=SLACK_WEBHOOK_URL_not_configured]")

  async notifyConversationStarted({ accountId, sessionUlid, startedAt })
    if !webhookUrl: return
    try:
      await sendRequest(buildConversationStartedBlocks(...), "conversation_started", "🟢 New conversation started")
    catch error:
      logger.error("[errorType=... category=slack alertType=conversation_started]")
      sentryService.captureException(error, { tags: { category: "slack", alert_type: "conversation_started" } })

  async notifyCartCreated({ accountId, sessionUlid, cartTotalCents, itemCount })
    if !webhookUrl: return
    try:
      await sendRequest(buildCartCreatedBlocks(...), "cart_created", "🛒 Cart created by AI agent")
    catch error:
      logger.error("[errorType=... category=slack alertType=cart_created]")
      sentryService.captureException(error, { tags: { category: "slack", alert_type: "cart_created" } })

  async notifyCheckoutLinkGenerated({ accountId, sessionUlid, checkoutUrl })
    if !webhookUrl: return
    try:
      await sendRequest(buildCheckoutLinkBlocks(...), "checkout_link", "🔗 Checkout link generated")
    catch error:
      logger.error("[errorType=... category=slack alertType=checkout_link]")
      sentryService.captureException(error, { tags: { category: "slack", alert_type: "checkout_link" } })

  private async sendRequest(blocks, alertType, fallbackText)
    signal = AbortSignal.timeout(5000)
    response = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: fallbackText, blocks }), signal })
    if !response.ok:
      responseText = await response.text().catch(() => "(unreadable)")
      throw new Error(`Slack POST failed [status=${response.status} alertType=${alertType}]`)
    logger.debug("[action=slack_alert_sent alertType=...]")

  private buildConversationStartedBlocks(...)  → Block[]
  private buildCartCreatedBlocks(...)          → Block[]
  private buildCheckoutLinkBlocks(...)         → Block[]
```

---

## Block JSON for Each Alert

All three blocks arrays conform to the verified Slack contract.

### 1. Conversation Started

Fallback text: `"🟢 New conversation started"`

```json
[
  {
    "type": "header",
    "text": {
      "type": "plain_text",
      "text": "🟢 New conversation started"
    }
  },
  {
    "type": "section",
    "fields": [
      {
        "type": "mrkdwn",
        "text": "*Account ID*"
      },
      {
        "type": "mrkdwn",
        "text": "*Session ID*"
      },
      {
        "type": "plain_text",
        "text": "<accountId value>"
      },
      {
        "type": "plain_text",
        "text": "<sessionUlid value>"
      }
    ]
  },
  {
    "type": "divider"
  }
]
```

Note: The `startedAt` date is not rendered as a separate field because Slack timestamps the message automatically and the `startedAt` value passed in is the server `new Date()` at session creation — redundant with Slack's own timestamp.

### 2. Cart Created

Fallback text: `"🛒 Cart created by AI agent"`

```json
[
  {
    "type": "header",
    "text": {
      "type": "plain_text",
      "text": "🛒 Cart created by AI agent"
    }
  },
  {
    "type": "section",
    "fields": [
      {
        "type": "mrkdwn",
        "text": "*Account ID*"
      },
      {
        "type": "mrkdwn",
        "text": "*Session ID*"
      },
      {
        "type": "plain_text",
        "text": "<accountId value>"
      },
      {
        "type": "plain_text",
        "text": "<sessionUlid value>"
      },
      {
        "type": "mrkdwn",
        "text": "*Items*"
      },
      {
        "type": "mrkdwn",
        "text": "*Cart Total*"
      },
      {
        "type": "plain_text",
        "text": "<itemCount value>"
      },
      {
        "type": "plain_text",
        "text": "$<cartTotalCents / 100 formatted to 2 decimal places>"
      }
    ]
  },
  {
    "type": "divider"
  }
]
```

Note: `cartTotalCents` is divided by 100 and formatted as `$X.XX` by the block-building helper. The currency is always USD for v1 (confirmed by the `currency: "usd"` field in the preview-cart payload).

### 3. Checkout Link Generated

Fallback text: `"🔗 Checkout link generated"`

```json
[
  {
    "type": "header",
    "text": {
      "type": "plain_text",
      "text": "🔗 Checkout link generated"
    }
  },
  {
    "type": "section",
    "fields": [
      {
        "type": "mrkdwn",
        "text": "*Account ID*"
      },
      {
        "type": "mrkdwn",
        "text": "*Session ID*"
      },
      {
        "type": "plain_text",
        "text": "<accountId value>"
      },
      {
        "type": "plain_text",
        "text": "<sessionUlid value>"
      }
    ]
  },
  {
    "type": "actions",
    "elements": [
      {
        "type": "button",
        "text": {
          "type": "plain_text",
          "text": "Open Checkout Link"
        },
        "url": "<checkoutUrl value>",
        "style": "primary"
      }
    ]
  },
  {
    "type": "divider"
  }
]
```

Note on the actions block: Slack's documentation states that even URL-only buttons emit an interaction payload to the app. Since this is an incoming webhook (not a full Slack app with an interaction handler), the button click will open the URL in the browser but Slack will not receive an acknowledgement. This is acceptable behavior for a read-only notification. No `action_id` is required when using incoming webhooks with a pure `url` button.

---

## Conversation-Started: Detect-New-Session Mechanism

### Current state

`IdentityService.lookupOrCreateSession()` currently returns:

```typescript
Promise<{
  sessionUlid: string;
  onboardingCompletedAt: string | null;
  kickoffCompletedAt: string | null;
  budgetCents: number | null;
}>
```

There is no `wasCreated` field. The create path (line 191) and the resume path (line 69) both return the same shape. The race-condition recovery path (line 110) is a resume-equivalent — the write lost the race, so the session was created by another concurrent request.

### Required change

Extend the return type by adding `wasCreated: boolean`.

**Return value assignments:**

| Code path | `wasCreated` |
|---|---|
| Resume path (line 69 — `existingResult.Item` found) | `false` |
| Race-condition recovery path (line 110) | `false` |
| New session created successfully (line 191) | `true` |

The existing return type is declared inline in the method signature. Extract it into `src/types/ChatSession.ts` as a named export `LookupOrCreateSessionResult` — this is cleaner than an inline object type that now has four fields and is referenced in both the service and its spec. Alternatively, the inline union can be extended without extraction, but extraction is recommended for readability.

**Consumption in `WebChatController.createSession()`:**

```typescript
const sessionResult = await this.identityService.lookupOrCreateSession(
  "web",
  body.guestUlid,
  body.agentName,
  accountUlid,
);

if (sessionResult.wasCreated) {
  this.slackAlertService.notifyConversationStarted({
    accountId: accountUlid,
    sessionUlid: sessionResult.sessionUlid,
    startedAt: new Date(),
  }).catch(() => undefined);
}
```

The `.catch(() => undefined)` at the call site is intentional and must not be removed — it ensures the unhandled promise rejection suppressor is explicit and visible to code reviewers (see fire-and-forget model discussion below).

---

## Per-Call-Site Additions

### 1. `WebChatController.createSession()`

File: `src/controllers/web-chat.controller.ts`

**Constructor injection addition:**

```typescript
constructor(
  private readonly identityService: IdentityService,
  private readonly chatSessionService: ChatSessionService,
  private readonly agentRegistry: AgentRegistryService,
  private readonly originAllowlistService: OriginAllowlistService,
  private readonly slackAlertService: SlackAlertService,
) {}
```

**Success-path addition** (after `sessionResult` is obtained and before the `logger.debug` line):

```typescript
if (sessionResult.wasCreated) {
  this.slackAlertService.notifyConversationStarted({
    accountId: accountUlid,
    sessionUlid: sessionResult.sessionUlid,
    startedAt: new Date(),
  }).catch(() => undefined);
}
```

**Import addition:**

```typescript
import { SlackAlertService } from "../services/slack-alert.service";
```

### 2. `PreviewCartTool.execute()`

File: `src/tools/preview-cart.tool.ts`

**Constructor injection addition:**

```typescript
constructor(
  @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
  private readonly databaseConfig: DatabaseConfigService,
  private readonly configService: ConfigService,
  private readonly slackAlertService: SlackAlertService,
) {
  this.gsiName = ...;
}
```

**Success-path addition** (after Step 12 comment, before `return { result: JSON.stringify(payload) }`):

```typescript
if (itemCount > 0) {
  this.slackAlertService.notifyCartCreated({
    accountId: accountUlid,
    sessionUlid,
    cartTotalCents: cartTotal,
    itemCount,
  }).catch(() => undefined);
}
```

Note: `cartTotal` is the sum of `cartItem.total` values (already computed at line 501 as a number in dollars, NOT cents). See the risk note below — the field name `cartTotalCents` in the service API implies cents, but the `preview-cart` tool computes `cartTotal` in dollars. The block-building helper will need to handle this correctly. See "Risks" section.

**Import addition:**

```typescript
import { SlackAlertService } from "../services/slack-alert.service";
```

### 3. `GenerateCheckoutLinkTool.execute()`

File: `src/tools/generate-checkout-link.tool.ts`

**Constructor injection addition:**

```typescript
constructor(
  @Inject(DYNAMO_DB_CLIENT) private readonly dynamoDb: DynamoDBDocumentClient,
  private readonly databaseConfig: DatabaseConfigService,
  private readonly configService: ConfigService,
  private readonly slackAlertService: SlackAlertService,
) {
  this.checkoutBaseUrlOverride = ...;
}
```

**Success-path addition** (after Step 6 comment, before `return { result: JSON.stringify({ checkout_url, cart_id }) }`):

```typescript
this.slackAlertService.notifyCheckoutLinkGenerated({
  accountId: accountUlid,
  sessionUlid,
  checkoutUrl: checkout_url,
}).catch(() => undefined);
```

**Import addition:**

```typescript
import { SlackAlertService } from "../services/slack-alert.service";
```

---

## Fire-and-Forget Execution Model

**Decision: callers call the async method without await, with an explicit `.catch(() => undefined)` chain.**

The public methods remain fully `async` (they `await` the internal `fetch` call). The call site opts out of awaiting by writing:

```typescript
this.slackAlertService.notifyConversationStarted(...).catch(() => undefined);
```

**Rationale:**

1. **Testability.** By keeping the methods `async` and `await`-able, unit tests can `await notifyConversationStarted(...)` and assert on the behavior synchronously. If the method internally swallowed the promise with `void fetch(...)`, tests would need timer mocking or workarounds.

2. **Explicit intent at call site.** The `.catch(() => undefined)` at the injection point is a visible contract that reviewers can audit: "this call is intentionally not blocking." If a future developer accidentally adds `await`, the fire-and-forget guarantee breaks — the explicit pattern makes the mistake obvious.

3. **Error double-handling avoidance.** The `notifyX` methods already catch all errors internally (log + forward to Sentry). The `.catch(() => undefined)` at the call site is a safety net for any unforeseen path where an exception escapes the internal try/catch. It suppresses the unhandled promise rejection without swallowing anything that wasn't already handled.

**What the internal method does NOT do:** It does not use `void` internally (e.g., `void this.sendRequest(...)`), because that would make the method return `undefined` synchronously and lose testability of the async behavior.

---

## Environment Variable Chain

### `src/config/env.schema.ts`

Add to the `envSchema` object:

```typescript
SLACK_WEBHOOK_URL: z.string().url().optional(),
```

### `src/config/configuration.ts`

Add a `slack` namespace:

```typescript
slack: {
  webhookUrl: process.env.SLACK_WEBHOOK_URL,
},
```

---

## Module Registration

File: `src/app.module.ts`

Add to the `providers` array (alongside `SentryConfigService` and `SentryService` for consistency):

```typescript
SlackAlertConfigService,
SlackAlertService,
```

Add the corresponding imports at the top of the file:

```typescript
import { SlackAlertConfigService } from "./services/slack-alert-config.service";
import { SlackAlertService } from "./services/slack-alert.service";
```

---

## Step-by-Step Implementation Sequence

```
1. [File: src/config/env.schema.ts] Add SLACK_WEBHOOK_URL env var
   - Why first: all downstream config reads depend on the schema being valid
   - Done when: `npm run build` compiles without errors

2. [File: src/config/configuration.ts] Add slack.webhookUrl namespace
   - Why here: config service getter targets this path; must exist before the service is used
   - Done when: `configService.get("slack.webhookUrl")` resolves to the env var value

3. [File: src/services/slack-alert-config.service.ts] Create SlackAlertConfigService
   - Why here: consumed by SlackAlertService constructor; must exist first
   - Done when: class compiles with the single webhookUrl getter

4. [File: src/services/slack-alert-config.service.spec.ts] Create spec for SlackAlertConfigService
   - Why here: validates the config path before the full service is built
   - Done when: spec passes with ConfigService mock

5. [File: src/types/ChatSession.ts] Add LookupOrCreateSessionResult named export (optional but recommended), add wasCreated: boolean
   - Why here: IdentityService return type change is a shared contract; extracting it avoids duplication between service and spec
   - Done when: type is exported and both service and spec import it

6. [File: src/services/identity.service.ts] Add wasCreated: boolean to lookupOrCreateSession() return type
   - Why here: WebChatController reads this signal; must be in place before the controller is modified
   - Done when: all three return sites set the field correctly (true on new create, false on resume and race recovery)

7. [File: src/services/identity.service.spec.ts] Add wasCreated assertions
   - Why here: validates the return-type addition before other code depends on it
   - Done when: new assertions pass; existing tests still pass

8. [File: src/services/slack-alert.service.ts] Create SlackAlertService
   - Why here: core implementation; depends on SlackAlertConfigService and SentryService (both exist)
   - Done when: class compiles; no-op path, sendRequest path, and three public methods all implemented

9. [File: src/services/slack-alert.service.spec.ts] Create spec for SlackAlertService
   - Why here: validates all behavior paths before injection sites are modified
   - Done when: all test cases pass (see testing strategy)

10. [File: src/app.module.ts] Register SlackAlertConfigService and SlackAlertService in providers
    - Why here: NestJS DI must know about the service before it can be injected
    - Done when: module compiles; `npm run build` passes

11. [File: src/controllers/web-chat.controller.ts] Inject SlackAlertService; add wasCreated-gated fire-and-forget call
    - Why here: depends on wasCreated signal (step 6) and SlackAlertService (step 8)
    - Done when: createSession() calls notifyConversationStarted().catch() after a new session

12. [File: src/tools/preview-cart.tool.ts] Inject SlackAlertService; add itemCount-gated fire-and-forget call
    - Why here: depends on SlackAlertService (step 8)
    - Done when: execute() calls notifyCartCreated().catch() after a successful non-empty cart write

13. [File: src/tools/generate-checkout-link.tool.ts] Inject SlackAlertService; add fire-and-forget call
    - Why here: depends on SlackAlertService (step 8)
    - Done when: execute() calls notifyCheckoutLinkGenerated().catch() after checkout_url is constructed

14. Run npm run build and npm test
    - Done when: build clean, all tests pass
```

---

## Testing Strategy

### `SlackAlertService` spec

The spec must mock `global.fetch` using `jest.spyOn(global, "fetch")` or `jest.fn()` assigned to `global.fetch`. No real network calls.

Mock `SentryService` using a plain object with `captureException: jest.fn()`.

**Test groups and cases:**

**No-op when SLACK_WEBHOOK_URL unset**
- `notifyConversationStarted` returns without calling fetch when webhookUrl is undefined
- `notifyCartCreated` returns without calling fetch when webhookUrl is undefined
- `notifyCheckoutLinkGenerated` returns without calling fetch when webhookUrl is undefined
- Boot-time log contains `slack_alerts_disabled` when webhookUrl is undefined
- No per-call log when webhookUrl is undefined and a method is called

**Successful POST — conversation started**
- `fetch` is called with `POST` and `Content-Type: application/json`
- Body JSON contains `text` fallback and `blocks` array with header text `"🟢 New conversation started"`
- Body JSON blocks contain the accountId and sessionUlid values
- Webhook URL does not appear in any logged string
- Resolves without error when `fetch` returns `{ ok: true, status: 200 }`

**Successful POST — cart created**
- Body JSON contains `"🛒 Cart created by AI agent"`
- Body JSON blocks contain itemCount and formatted cart total
- Alert does NOT fire (no fetch call) when `itemCount = 0` — NOTE: this test belongs in the call-site spec, not the service spec, since the service method itself does not check itemCount. The gate is at the injection site.

**Successful POST — checkout link generated**
- Body JSON contains `"🔗 Checkout link generated"`
- Body JSON blocks actions element contains the checkoutUrl in the `url` field
- Checkout URL appears in blocks but NOT in any logged string

**HTTP failure → Sentry capture**
- `fetch` returns `{ ok: false, status: 429 }` → `sentryService.captureException` is called with `tags: { category: "slack", alert_type: "conversation_started" }`
- `fetch` throws a `TypeError` (network error) → same Sentry capture behavior
- Error is NOT re-thrown (promise resolves without rejection)
- Error log contains `category=slack` and `alertType=conversation_started` (or relevant type)
- Error log does NOT contain the webhook URL

**Abort on timeout**
- Mock `AbortSignal.timeout` to immediately signal abort, or mock `fetch` to throw `AbortError`
- Verify `captureException` is called with appropriate tags
- Verify the calling method resolves (does not propagate the abort error)

### `SlackAlertConfigService` spec

- `webhookUrl` returns `undefined` when `ConfigService.get` returns undefined
- `webhookUrl` returns the string when `ConfigService.get` returns a URL string

### `IdentityService` spec additions

- `lookupOrCreateSession` returns `wasCreated: true` when no identity record exists (new session branch)
- `lookupOrCreateSession` returns `wasCreated: false` when identity record already exists (resume branch)
- `lookupOrCreateSession` returns `wasCreated: false` when the race-condition recovery branch is taken

### Per-call-site specs

**`WebChatController.createSession()` spec:**
- When `identityService.lookupOrCreateSession` returns `wasCreated: true`: `slackAlertService.notifyConversationStarted` is called once with `accountId`, `sessionUlid`, and a `startedAt` Date
- When `identityService.lookupOrCreateSession` returns `wasCreated: false`: `slackAlertService.notifyConversationStarted` is NOT called
- The controller returns the session response regardless of `slackAlertService` behavior (mock it to reject — controller still returns 201)

**`PreviewCartTool.execute()` spec:**
- When execute succeeds with non-empty items: `slackAlertService.notifyCartCreated` is called once with correct `itemCount` and `cartTotalCents`
- When `itemCount = 0` (constructed from zero-quantity items): `slackAlertService.notifyCartCreated` is NOT called (this edge case is theoretical given the input schema requires `minimum: 1` per item quantity, but the gate should still be verified)
- The tool returns the cart payload regardless of `slackAlertService` behavior

**`GenerateCheckoutLinkTool.execute()` spec:**
- When execute succeeds: `slackAlertService.notifyCheckoutLinkGenerated` is called once with `accountId`, `sessionUlid`, and the `checkout_url` value
- The tool returns the checkout result regardless of `slackAlertService` behavior

---

## Risks and Edge Cases

### HIGH: `cartTotal` units mismatch (dollars vs. cents)

The `SlackAlertService.notifyCartCreated()` API takes `cartTotalCents: number` (name implies cents). However, `PreviewCartTool` computes `cartTotal` by summing `cartItem.total` values, where `cartItem.price` comes from `service.price` (a DynamoDB attribute). Inspecting the tool, `resolveServicePrice()` parses the price as a raw number from DynamoDB — there is no explicit cents/dollars annotation anywhere in the tool or its types.

**The mismatch risk:** If `service.price` in DynamoDB stores values in dollars (e.g., `49.99`), then `cartTotal` is in dollars, and passing it as `cartTotalCents` will result in a Slack message showing `$0.50` for a $49.99 service.

**Mitigation:** The implementer must verify the DynamoDB schema convention for the `price` field in service records. If prices are stored in dollars, the call site must multiply by 100: `cartTotalCents: Math.round(cartTotal * 100)`. If stored in cents, pass directly. This must be confirmed against the actual data before the alert fires in production. Flag to the user before Step 2.

### HIGH: Webhook URL must never appear in logs

Every `logger.error`, `logger.warn`, `logger.debug`, thrown error message, and Sentry capture must be audited. The webhook URL must never be interpolated into any string. The `sendRequest` helper's error path must log `alertType` and HTTP `status` only — never `response.url` or the URL passed to `fetch`. The code reviewer in Step 5 will check this explicitly.

### MEDIUM: Slack actions block and incoming webhooks

Slack's documentation notes that button clicks in an `actions` block emit interaction payloads. With an incoming webhook (not a full bot), there is no interaction endpoint to receive those. In practice, clicking the URL button will open the URL in the browser and Slack will silently fail to deliver the interaction payload. This is harmless for our use case (pure notification), but it is worth noting.

**Mitigation:** If this causes noise (Slack may show a "Your app isn't responding" warning in some configurations), replace the `actions` block with a `section` block that includes the URL as a mrkdwn link: `"<checkoutUrl|Open Checkout Link>"`. This avoids the interactive button pattern entirely and is simpler. Recommend this alternative to the user before Step 2.

### MEDIUM: Volume concern for cart_created (no session-level dedup in v1)

The brief acknowledges this as a known concern. Each time the agent calls `preview_cart` for the same session, a `cart_created` alert fires. For an engaged session, this could mean multiple alerts. The alert is accurate (a new cart state was written) but may feel noisy.

**Mitigation:** Documented as deferred per the brief. No action required for v1.

### MEDIUM: Race condition in the conversation-started gate

`lookupOrCreateSession` has a `ConditionalCheckFailedException` recovery path where a concurrent request won the write race. In this case, `wasCreated` is `false` (the current request did not create the session). This is correct — the winning request fired the alert. However, if the winning request was processed on a different pod that also fires the alert, the conversation-started alert fires exactly once (from the winner). If the winning request's pod crashes before firing the alert, the alert is lost. This is acceptable for v1; session-level dedup would require a DDB flag which is out of scope.

### LOW: `AbortSignal.timeout()` availability

`AbortSignal.timeout()` was introduced in Node 17.3. The project runs on Node 18+, so this is safe. Confirm the `engines` field in `package.json` if uncertain.

### LOW: Boot-time log only fires once

The no-op log (`slack_alerts_disabled`) fires only if `SLACK_WEBHOOK_URL` is unset at construction time. If the env var is set after the service is instantiated (not a NestJS pattern, but worth noting), the service would remain in no-op mode. This is not a real risk in NestJS's DI lifecycle.

---

## Out-of-Scope Confirmations

Per the brief, the following are explicitly NOT implemented in this phase:
- Lead-captured event
- Error alerts in the Slack channel (Sentry owns errors)
- Account-name resolution (raw accountUlid used for v1)
- Session-level dedup for cart_created
- Aggregation, batching, or digest mode
- Multiple webhook URLs or channel routing
- Slack interactive features (slash commands, threading)
- Slack alerts for non-shopping events (ingestion, enrichment)

---

## Implementation Recommendations

1. **Confirm `cartTotal` units** with the user before Step 2 begins. This is the highest-risk data contract question in the entire plan. A quick query on a known service record in the DynamoDB table will confirm whether `price` is stored in dollars or cents.

2. **Consider the `section` block with mrkdwn link** instead of `actions` block for the checkout URL, to avoid the interaction-payload noise. Proposed alternative block for alert 3:
   ```json
   {
     "type": "section",
     "text": {
       "type": "mrkdwn",
       "text": "<CHECKOUT_URL|Open Checkout Link>"
     }
   }
   ```
   This renders as a hyperlink inline and avoids any interactive callback complexity.

3. **Extract `LookupOrCreateSessionResult` to `src/types/ChatSession.ts`** rather than expanding the inline return type annotation in the method signature. The type is now complex enough to warrant naming.

4. **Follow the `SentryService` spec pattern** for the `SlackAlertService` spec: use `jest.spyOn` on `Logger.prototype` methods to assert log calls, and `jest.clearAllMocks()` in `beforeEach`.

5. **The `startedAt` field** passed to `notifyConversationStarted` should be `new Date()` at the call site in the controller, which is a few milliseconds after session creation completes. This is intentional — it reflects when the server acknowledged the session, not when the DB write started.
