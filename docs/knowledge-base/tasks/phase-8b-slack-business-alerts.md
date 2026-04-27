TASK OVERVIEW
Task name: Phase 8b — Slack alerts for business signals (shopping flow)

Objective:
Wire Slack notifications into three high-signal moments in the shopping-assistant flow: a customer starts a conversation, the agent creates a cart with items, and the agent hands the customer a checkout URL. The team sees real-time business activity in `#instapaytient-agentic-ai-alerts` without needing to scroll Sentry, dashboards, or DDB. **This Slack channel is exclusively for celebration / awareness signals — error alerts continue to go to Sentry only.** No mixing.

When this phase is done:
- A single reusable `SlackAlertService` exposes three typed methods, one per business signal.
- Three injection sites (controller + two tools) call the service as a side effect after their success path.
- `SLACK_WEBHOOK_URL` unset → service no-ops gracefully, allowing local dev with no Slack config.
- Slack failures (network, rate limit, malformed webhook) are caught and forwarded to Sentry, never propagated back into the calling tool/controller — they must NEVER block business logic.
- All existing tests still pass; new tests cover the service surface (no-op behavior, payload formatting, fire-and-forget failure handling).

Relevant context:
- The reusable `SlackAlertService` is the **only** chokepoint that knows how to talk to Slack. Adding a fourth alert later = one new method on this class. Replacing Slack with another notifier later = swap the implementation behind these method names.
- Pattern is **side-effect inside existing code paths**, NOT a new tool the agent calls. Reasons:
  - We want alerts on objective business events, not when Claude decides to remember them.
  - Deterministic (always fires on event) > prompt-fidelity-dependent.
  - No latency added to the agent loop.
- The configuration chain mirrors every existing service (`SlackAlertConfigService` → `configuration.ts` → `env.schema.ts` → `.env.local`), identical in shape to `AnthropicConfigService`, `SentryConfigService`, etc.
- For the conversation-started alert specifically: we want to fire only on **truly new** sessions, not on resumed sessions where an existing `(guestUlid, accountUlid, agentName)` tuple already had a session. The current `IdentityService.lookupOrCreateSession()` may or may not expose a "was newly created" signal; the arch-planner will inspect and propose a small return-shape addition if needed.
- All three alerts include `accountId` (raw 26-char ULID, no `A#` prefix) and `sessionUlid`. They do NOT include human-readable account names (no lookup exists yet); pretty names are a future Phase 8 enhancement.
- Slack message format uses **blocks** (not plain text) for clean rendering — header, fields, divider. The exact block structure is finalized at planning time.

Key contracts (locked by the user before this brief — do not relitigate):

**Three alerts, all with the shopping flow:**

1. **Conversation started** — fires when `POST /chat/web/sessions` creates a NEW session (not on resume). Fires from `WebChatController.createSession()` after the session creation succeeds.
2. **Cart created** — fires when `PreviewCartTool.execute()` returns a successful cart with `itemCount > 0`. Fires every time the tool succeeds with non-empty cart (no session-level dedup in v1; documented as a known volume concern). Empty-cart returns do NOT trigger an alert.
3. **Checkout URL generated** — fires when `GenerateCheckoutLinkTool.execute()` returns a successful URL. Fires every time the tool succeeds.

**`SlackAlertService` public API (final shape, locked):**

```typescript
@Injectable()
class SlackAlertService {
  async notifyConversationStarted(input: {
    accountId: string;
    sessionUlid: string;
    startedAt: Date;
  }): Promise<void>;

  async notifyCartCreated(input: {
    accountId: string;
    sessionUlid: string;
    cartTotalCents: number;
    itemCount: number;
  }): Promise<void>;

  async notifyCheckoutLinkGenerated(input: {
    accountId: string;
    sessionUlid: string;
    checkoutUrl: string;
  }): Promise<void>;
}
```

All three methods:
- Return `Promise<void>`. No useful return value — caller does not await/block.
- No-op silently when `SLACK_WEBHOOK_URL` is unset.
- Fire-and-forget: catch any Slack/network failure internally, log via the bracketed `[key=value]` format, and report to Sentry (`SentryService.captureException`). Do NOT re-throw. The calling tool/controller must continue regardless of Slack health.

**`SlackAlertConfigService` shape (locked):**

```typescript
@Injectable()
class SlackAlertConfigService {
  constructor(private readonly configService: ConfigService) {}

  get webhookUrl(): string | undefined {
    return this.configService.get<string>("slack.webhookUrl", { infer: true });
  }
}
```

Mirrors `AnthropicConfigService` exactly in style.

**Slack message format (locked — uses Slack blocks):**

Each alert uses Slack's "blocks" format with:
- A heading block (emoji + short title): `🟢 New conversation started`, `🛒 Cart created by AI agent`, `🔗 Checkout link generated`
- A section block with key-value fields (account, session, contextual data)
- For checkout, a clickable link button to the URL
- Timestamp included naturally via Slack's own message timestamp (no need to render manually)

The arch-planner finalizes the exact block JSON in the plan; the implementer pastes it verbatim.

**No-op behavior (locked):**
- `SLACK_WEBHOOK_URL` empty/unset → all three methods return immediately without any HTTP call. Logged once at boot ("Slack alerts disabled — SLACK_WEBHOOK_URL not configured") via `Logger.log`. Do NOT log per-alert in no-op mode (would be noise).

**Failure-handling (locked):**
- HTTP failure (non-2xx response from Slack, network timeout): caught, logged with `[errorType=... category=slack]`, captured to Sentry with `tags: { category: "slack", alert_type: "conversation_started" | "cart_created" | "checkout_link" }`, never re-thrown.
- Reason: a Slack outage must never break a customer's checkout flow. Business logic strictly precedes Slack notification.

**HTTP client:**
- Use Node's built-in `fetch` (Node 18+ provides this natively). NO new dependencies.
- POST `application/json` to the webhook URL.
- 5-second timeout via `AbortSignal.timeout(5000)`. If Slack is hung, abort fast.

**Out of scope for Phase 8b (do not add):**
- Lead-captured event (deferred — user opted out for v1).
- Error alerts in this channel — Sentry continues to own error visibility; this channel is exclusively business signals.
- Account-name resolution (display "SNOUT Pet Services" instead of `01K2XR...`). Just use raw accountUlid for v1.
- Session-level dedup (only fire first cart_created per session) — defer; documented as known volume concern.
- Aggregation / batching / digest mode — defer.
- Multiple webhook URLs / channel routing — single channel for v1.
- Slack interactive features (slash commands, threading, replies) — would require a bot user; defer.
- Slack alerts for phases beyond shopping (knowledge base ingestion events, etc.) — out of scope; this phase is shopping flow only.


STEP 1 — ARCHITECTURE PLANNING
Use the arch-planner agent to analyze the codebase and produce a structured implementation plan.

Task specifics for this plan:

1. Read this brief in full. Read `docs/knowledge-base/phase-8-considerations.md` to understand where 8b sits in the broader Phase 8 roadmap.

2. Study the existing patterns the new code must mirror:
   - `src/services/anthropic-config.service.ts`, `src/services/database-config.service.ts`, `src/services/sentry-config.service.ts` — the typed config service pattern. New `SlackAlertConfigService` is a copy-paste with field renames.
   - `src/services/sentry.service.ts` — the wrapper-service pattern for an external integration with no-op-when-disabled behavior. New `SlackAlertService` follows this exact shape.
   - `src/controllers/web-chat.controller.ts` — `createSession()` is where the conversation-started alert fires from.
   - `src/services/identity.service.ts` — the `lookupOrCreateSession()` method. Inspect whether it returns a signal indicating "newly created vs. resumed." If not, propose a small return-shape addition (e.g., add a `wasCreated: boolean` field to the existing return type).
   - `src/tools/preview-cart.tool.ts` — `execute()` success path is where the cart-created alert fires. Confirm what `itemCount` and `cartTotalCents` look like in the existing response shape.
   - `src/tools/generate-checkout-link.tool.ts` — `execute()` success path is where the checkout-link alert fires. Confirm the URL field name in the existing response.
   - Log-line format: bracketed `[key=value key=value]` everywhere.
   - Sentry capture pattern: `this.sentryService.captureException(error, { tags: { category: "slack", alert_type: "..." } })`.

3. Verify the Slack incoming-webhook contract against live documentation:
   - The webhook URL accepts a JSON POST.
   - The "blocks" format spec (header block, section block with markdown text + fields, action block for the checkout link).
   - Source: `https://api.slack.com/messaging/webhooks`, `https://api.slack.com/block-kit`.
   - Confirm Slack's response shape and rate-limit behavior so the failure-handling logic is grounded.

4. Produce a detailed implementation plan covering ALL of these sections:
   - **Overview** — one paragraph.
   - **Affected files / modules** — comprehensive list with one-line note per file.
   - **Slack webhook verification findings** — confirmed contract details with source URLs.
   - **`SlackAlertService` design** — exact class shape with the three typed methods. Include the no-op gate, the fire-and-forget try/catch with Sentry forwarding, the `fetch` call shape with abort timeout, and the block-building helper for each alert type.
   - **`SlackAlertConfigService` design** — exact getter shape mirroring `AnthropicConfigService`.
   - **Block JSON for each alert** — exact JSON the implementer pastes verbatim. Cover all three alert types.
   - **Conversation-started: detect-new-session mechanism** — inspect `IdentityService.lookupOrCreateSession()` and determine if a "wasCreated" signal already exists or needs to be added. If it needs to be added, prescribe the exact change (e.g., expand the return type to include `wasCreated: boolean`, set `true` only on the create branch, `false` on the resume branch).
   - **Per-call-site additions** — for each of the three injection sites (`WebChatController.createSession`, `PreviewCartTool.execute`, `GenerateCheckoutLinkTool.execute`), the exact code snippet the implementer adds, including:
     - The constructor injection of `SlackAlertService`
     - The success-path call to the appropriate `notify*` method
     - For `PreviewCartTool`: the conditional gate (`itemCount > 0`) before the call
   - **Module registration** — what gets added to `app.module.ts` providers.
   - **Step-by-step implementation order** — file-by-file.
   - **Testing strategy** — `SlackAlertService` spec covers: no-op when DSN unset, successful POST per alert type, HTTP failure → Sentry capture, abort-on-timeout. Per-call-site specs cover that the alert fires after success and is NOT awaited blocking the response. Use mocked `fetch` (no real network calls in tests).
   - **Risks and edge cases** — webhook URL leaked into logs (NEVER log it), Slack rate limiting causing many sequential failures, the `notify*` method awaiting a slow Slack and blocking the controller response (must be fire-and-forget — clarify whether the methods are awaited or called as `.catch()` chains), volume considerations at scale.
   - **Out-of-scope confirmations.**

5. Write your plan to `docs/knowledge-base/tasks/phase-8b-slack-business-alerts-plan.md`.

6. Return a concise summary (under 600 words) including:
   - Path to the plan file
   - 5–7 key decisions or clarifications you made — particularly around the new-vs-resumed session detection mechanism, the fire-and-forget execution model (await vs. void), and the Slack block JSON design choices
   - Any risks or unknowns the orchestrator should flag to the user before approval

Pause after producing the plan so the orchestrator can get user approval before Step 2.


STEP 2 — IMPLEMENTATION
Use the code-implementer agent to implement the approved plan.

Implementation details for this task:
- Create `SlackAlertService` and `SlackAlertConfigService` per the plan exactly.
- Add the env-var chain (`SLACK_WEBHOOK_URL` in `env.schema.ts`, namespaced in `configuration.ts`).
- Register both services in `src/app.module.ts`.
- Add the constructor injection + call site to all three target locations (`WebChatController.createSession`, `PreviewCartTool.execute`, `GenerateCheckoutLinkTool.execute`).
- If the plan prescribes changes to `IdentityService.lookupOrCreateSession()` for the `wasCreated` signal, apply them carefully — that's a public-API addition to an existing service that other code may depend on.
- The webhook URL must NEVER appear in logs, thrown errors, or Sentry events. Log the alert TYPE and SUCCESS/FAILURE only, never the URL contents.
- Run `npm run build` and `npm test` before returning.
- Commit on master. Suggested subject: `feat(observability): add Slack business-signal alerts (conversations, carts, checkouts)`. **Do NOT add `Co-Authored-By:` or credit Claude.**

Implementation requirements:
- follow the plan produced by the arch-planner agent
- modify or create only the necessary files
- respect existing architecture and coding patterns
- focus on correctness first (style will be handled later)


STEP 3 — STYLE REFACTOR
Use the style-refactor agent to refactor the implementation according to the rules defined in `.claude/instructions/style-enforcer.md`.

Style refactor specifics:
- The new service files mirror the existing service style exactly (constructor DI, logger, named constants, sanitized error handling).
- Bracketed `[key=value]` log format throughout.
- Webhook URL never in log lines or thrown errors.
- Block-building helpers (per-alert-type) live in the same file as `SlackAlertService` — keep them as private methods or unexported helpers; do NOT export.
- No `any`, no inline type annotations TypeScript can infer, no dead code, no placeholder comments.

Style requirements:
- apply all rules from style-enforcer.md
- improve readability, structure, and consistency
- align code with project conventions and standards
- do not change functionality or logic
- do not introduce new behavior


STEP 4 — TEST EXECUTION
Use the test-suite-runner agent to execute the project's test suite.

Testing context for this task:
- Run `npm run build` first.
- Run `npm test`. Baseline before this phase: 409 tests. Phase 8b adds tests for the SlackAlertService (no-op, success, failure paths for each of three methods), SlackAlertConfigService, and the per-call-site integrations.
- Estimated new total: ~430.
- Mock `fetch` globally; tests must NOT make real network calls. Mock `SentryService` per the existing test pattern.

Testing requirements:
- run the project's standard test command
- report all failing tests clearly
- summarize results
- do not modify code or attempt fixes


STEP 5 — CODE REVIEW
Use the code-reviewer agent to review the implementation.

Review focus for this task:
- **Webhook URL is never logged or sent to Sentry.** Search every log line, throw, error_summary, and Sentry capture path. Confirm absence.
- **Fire-and-forget guarantee.** A failing Slack call (network error, non-2xx response) must NEVER propagate back into the calling tool/controller. The controller's HTTP response and the tool's return value must be unaffected.
- **No-op when `SLACK_WEBHOOK_URL` unset** — service silently does nothing, no `fetch` call attempted.
- **Conversation-started fires only on truly new sessions, not on resumes** — verify the gate based on whatever signal `IdentityService` exposes.
- **Cart-created gate respects `itemCount > 0`** — empty cart calls do NOT alert.
- **Per-account isolation** — every alert payload includes `accountId`. No cross-tenant data leakage possible.
- **Existing log lines preserved** — Slack call is purely additive.
- **Out-of-scope respected** — no error alerts, no lead-captured event, no account-name lookup, no session-level cart dedup, no aggregation logic, no second webhook URL, no slash commands.
- **Sentry forwarding correct** — Slack failures captured with `tags: { category: "slack", alert_type: "..." }`. PII scrubbing in `beforeSend` already covers any leaked account/session IDs (we expect those to flow through, but customer content like names/emails should never be in these payloads anyway).

Review requirements:
- verify correctness of the implementation
- confirm alignment with the architectural plan
- evaluate maintainability, security, and performance
- ensure style refactor did not alter functionality
- report issues using structured review feedback
