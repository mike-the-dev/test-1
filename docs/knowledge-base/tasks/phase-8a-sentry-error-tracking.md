TASK OVERVIEW
Task name: Phase 8a — Sentry error tracking

Objective:
Add Sentry as the project's error-tracking backbone. Today, when something fails in a Voyage call, a Qdrant operation, an enrichment per-chunk, or an ingestion job, the only signal is a log line buried in the dev server output. Operators have to be reading logs to find anything. After this phase, every uncaught exception and every known error path gets captured into Sentry automatically — categorized, tagged, and grouped for triage. Local dev stays unaffected (Sentry no-ops when `SENTRY_DSN` is unset). PII never reaches Sentry.

This is the foundation for Phase 8b (Slack alerts), which will subscribe to specific Sentry events and escalate them to Slack.

When this phase is done:
- The application boots with Sentry initialized when `SENTRY_DSN` is present, or in no-op mode when absent.
- Every unhandled exception in any handler/service/processor flows automatically to Sentry via the NestJS integration.
- Every catch block in the Knowledge Base feature (Voyage, Qdrant provider, ingestion service, enrichment service, ingestion processor) explicitly captures the error to Sentry with structured tags.
- `BadRequestException` and other validation-class errors are NOT captured (those are user errors, not bugs).
- Customer content (chat messages, document text, contact info) is NEVER captured — `beforeSend` strips it.
- All existing tests still pass; new tests cover the Sentry wrapper service and its no-op behavior when DSN is absent.

Relevant context:
- `@sentry/nestjs` is the official NestJS integration. It auto-instruments controllers, providers, and unhandled exceptions. We use it.
- The wrapper service pattern matters: rather than calling `Sentry.captureException` directly throughout the codebase, all call sites use a project-controlled `SentryService` (`this.sentryService.captureException(error, { tags })`). This makes the SDK swappable, testable (mock the wrapper), and gives us a single chokepoint for `beforeSend`-style filtering.
- The existing catch blocks already log errors with the bracketed `[key=value]` format. Sentry capture is ADDITIVE — keep the log line, add the capture. Logs stay for local dev observability; Sentry adds production observability.
- This phase is scoped to **Knowledge Base catch blocks** for the manual captures. The global NestJS exception filter will catch unhandled exceptions from non-KB code paths (chat-session, web-chat, etc.) automatically. A future cross-cutting pass can add manual captures elsewhere if needed.

Key contracts (locked by the user before this brief — do not relitigate):

**Sentry initialization:**
- Use `@sentry/nestjs` (NOT `@sentry/node` directly). Verify current stable version against npm at planning time.
- Initialize in `src/main.ts` BEFORE `NestFactory.create` (per Sentry's NestJS integration docs — must be first thing).
- If `SENTRY_DSN` env var is empty/unset, skip initialization entirely. The wrapper service detects this and no-ops all calls. Local dev requires no Sentry config.

**Wrapper service (`SentryService`):**
- Public API:
  - `captureException(error: unknown, context?: { tags?: Record<string, string>; extras?: Record<string, unknown> }): void` — fire-and-forget; never throws.
  - `captureMessage(message: string, level: "info" | "warning" | "error", context?: ...): void` — for cases where there's no exception object (e.g., "all chunks failed enrichment" warn).
  - `addBreadcrumb(message: string, category: string): void` — for stitching context across async boundaries.
- All methods are no-ops when DSN is absent.
- The service is stateless and singleton-scoped; safe to inject anywhere.

**`beforeSend` PII scrubbing:**
- Strip the following keys from any captured event's `extra`, `contexts`, `breadcrumbs`, or `request.data`:
  - `text` (document text passed to ingestion)
  - `message` (chat messages)
  - `chunk_text` (chunk content)
  - `enrichment` (Claude-generated enrichment text — though this is generated, not customer PII; still excluded as a defense-in-depth)
  - `email`, `phone`, `firstName`, `lastName` (contact info)
- Implementation: a `beforeSend` callback at `Sentry.init` time that walks the event and removes/redacts these keys recursively.
- Do NOT scrub `account_id`, `document_id`, `external_id`, `chunk_index`, `errorType`, `statusCode` — these are essential debugging metadata and contain no PII.

**Tagging convention for manual captures:**
- Every manual `captureException` call sets at least one tag: `category` ∈ `"voyage" | "qdrant" | "enrichment" | "ingestion-service" | "ingestion-processor" | "qdrant-startup"`.
- When `account_id` is in scope, also tag `account_id` so events group naturally per-tenant in Sentry.
- When `document_id` is in scope, also tag `document_id`.

**What gets manually captured vs. let-through-the-global-handler:**
- Manual capture (with tags): all KB-feature catch blocks listed in the affected-files section below.
- Auto-capture via global handler: every other unhandled exception app-wide.
- NOT captured: `BadRequestException` and its subclasses. These are validation errors thrown intentionally; capturing them would create noise. The plan must specify the mechanism to filter these (likely a `beforeSend` check or a explicit `if (error instanceof BadRequestException) return;` in capture sites).

**Per-chunk enrichment failures:**
- Capture every per-chunk enrichment failure, not sampled. Rationale: at our current ingestion rate, this is low-volume; volume isn't an issue. If it ever becomes one, switch to sampling later. Each capture is tagged `category=enrichment` plus `chunk_failure_kind=anthropic_error|parse_failure|empty_response` so Sentry can group meaningfully.

**Configuration:**
- Env vars (all optional except DSN-when-Sentry-is-desired):
  - `SENTRY_DSN` — the DSN URL. Empty/unset → Sentry disabled.
  - `SENTRY_ENVIRONMENT` — defaults to `process.env.APP_ENV ?? "local"`. Used for environment filtering in Sentry.
  - `SENTRY_RELEASE` — optional release identifier (e.g., git commit SHA). Used for release tracking. Operators can set this in CI.
  - `SENTRY_TRACES_SAMPLE_RATE` — defaults to `0.0`. Performance tracing is OUT OF SCOPE for Phase 8a; we only do error tracking.

Out of scope for Phase 8a (do not add):
- Slack alerting (Phase 8b).
- Performance monitoring / tracing — set `tracesSampleRate: 0`. Future work.
- User identification (Sentry's `setUser`) — out of scope until we have authenticated users; for now we tag account_id only.
- Source map upload to Sentry — CI/build concern, not application code.
- Manual captures in non-KB code paths — global handler covers them; targeted captures elsewhere can be added in a future cross-cutting pass.
- Sentry dashboard, alert rules, or project setup — those are configured in Sentry's UI, not code.


STEP 1 — ARCHITECTURE PLANNING
Use the arch-planner agent to analyze the codebase and produce a structured implementation plan.

Task specifics for this plan:

1. Read this brief in full. Read `docs/knowledge-base/phase-8-considerations.md` to understand where 8a sits in the broader Phase 8 roadmap. Read recent KB-feature commits to confirm which catch blocks exist today and need manual captures added.

2. Study the existing patterns the new code must mirror:
   - `src/services/voyage.service.ts` — external-API service pattern; current catch-block shape that needs Sentry added.
   - `src/services/knowledge-base-enrichment.service.ts` — same.
   - `src/services/knowledge-base-ingestion.service.ts` — multiple catch blocks (DDB writes, lookups, Qdrant ops).
   - `src/processors/knowledge-base-ingestion.processor.ts` — job-level catch with `UnrecoverableError` branching.
   - `src/providers/qdrant.provider.ts` — startup smoke check that currently logs "unreachable" warning — should also Sentry-capture.
   - `src/services/anthropic-config.service.ts`, `src/services/database-config.service.ts` — typed-config-service pattern the new `SentryConfigService` must mirror.
   - `src/main.ts` — Nest bootstrap; Sentry init goes at the top.
   - Log-line format: bracketed `[key=value]` everywhere.

3. Verify the `@sentry/nestjs` SDK against live documentation. Your training data is unreliable. Use WebFetch (or context7 if available) to confirm:
   - Current stable version of `@sentry/nestjs` on npm.
   - Initialization shape — `Sentry.init({ dsn, environment, release, tracesSampleRate, beforeSend, integrations })` and where it must be called (top of `main.ts` before `NestFactory.create`).
   - The NestJS-specific exception filter / interceptor: whether to register `SentryGlobalFilter` or it's auto-applied.
   - The `beforeSend(event, hint)` callback signature and what to inspect/mutate to scrub PII.
   - `captureException(error, scope)` signature for adding tags / extras.
   - Sources: `https://docs.sentry.io/platforms/javascript/guides/nestjs/`, `https://github.com/getsentry/sentry-javascript`, the installed package's `.d.ts` files at `node_modules/@sentry/nestjs/` AFTER you decide which version.

4. Produce a detailed implementation plan covering ALL of these sections:
   - **Overview** — one paragraph.
   - **Affected files / modules** — every file created or modified, one-line note per file.
   - **Sentry SDK verification findings** — exact Sentry init shape, exception filter pattern, beforeSend callback signature. Cite source URLs.
   - **`SentryService` design** — exact public API surface (the three methods plus any helpers). Behavior when DSN is absent (no-op vs. throw vs. log). Constructor pattern (does it own `Sentry.init`, or does that happen in `main.ts` and the service just wraps the SDK?).
   - **`SentryConfigService` design** — exact getters mirroring `AnthropicConfigService`/`DatabaseConfigService` style.
   - **Initialization placement in `main.ts`** — exact code block, including the conditional skip when DSN is empty.
   - **`beforeSend` PII scrubbing** — exact algorithm. Walk the event recursively, remove the listed keys. Show the algorithm in pseudocode in the plan.
   - **`BadRequestException` filtering** — whether to filter in `beforeSend` or at each capture site. Recommend the cleaner approach.
   - **Per-catch-block manual capture additions** — for each catch block in the KB code, the exact `sentryService.captureException(...)` call to add (with tags), AS A DIFF or PSEUDO-DIFF the implementer can apply mechanically. Cover every catch block in: voyage.service, knowledge-base-ingestion.service, knowledge-base-enrichment.service, knowledge-base-ingestion.processor, qdrant.provider.
   - **Module registration** — what gets added to `app.module.ts` (SentryService, SentryConfigService, the global exception filter if not auto).
   - **Step-by-step implementation order** — file-by-file.
   - **Testing strategy** — how to test the SentryService (mock the SDK, assert calls), how to test the no-op behavior, how to test PII scrubbing (run beforeSend on a synthetic event with PII fields, assert they're scrubbed). Tests must NOT require a real Sentry DSN.
   - **Risks and edge cases** — DSN misconfigured, Sentry rate-limiting our events, the case where `beforeSend` itself throws (would silently drop the event), captureException being called extremely frequently in a tight loop (rate-limit risk).
   - **Out-of-scope confirmations.**

5. Write your plan to `docs/knowledge-base/tasks/phase-8a-sentry-error-tracking-plan.md`.

6. Return a concise summary (under 600 words) with:
   - Path to the plan file
   - 5–7 key decisions or clarifications made (especially anything confirmed via live Sentry docs that affects the plan)
   - Any risks or unknowns the orchestrator should flag to the user before approval — particularly: the wrapper-service vs. direct-SDK question, whether to filter BadRequestException in beforeSend or at call sites, and whether all per-chunk enrichment failures should genuinely be captured or sampled.

Pause after producing the plan so the orchestrator can get user approval before Step 2.


STEP 2 — IMPLEMENTATION
Use the code-implementer agent to implement the approved plan.

Implementation details for this task:
- Add `@sentry/nestjs` at the version confirmed by the arch-planner. Pin specifically.
- Initialize Sentry at the top of `src/main.ts` per the plan's exact code block.
- Create `SentryService` and `SentryConfigService` per the plan.
- Add manual `captureException` calls to every KB catch block per the plan's per-catch-block additions. Keep all existing log lines; capture is ADDITIVE.
- Register the new services in `src/app.module.ts`.
- Add the env vars to `src/config/configuration.ts`, `src/config/env.schema.ts`, and append to `.env.local` as comments (no real DSN committed).
- Run `npm run build` and `npm test` before returning.
- Commit on master. Suggested subject: `feat(observability): add Sentry error tracking to KB feature catch paths`. **Do NOT add `Co-Authored-By:` or credit Claude.**

Implementation requirements:
- follow the plan produced by the arch-planner agent
- modify or create only the necessary files
- respect existing architecture and coding patterns
- focus on correctness first (style will be handled later)


STEP 3 — STYLE REFACTOR
Use the style-refactor agent to refactor the implementation according to the rules defined in `.claude/instructions/style-enforcer.md`.

Style refactor specifics:
- The new service files mirror the existing service style exactly (constructor DI, logger, named constants, sanitized error handling).
- Bracketed `[key=value]` log format.
- API keys and DSN values must NEVER appear in any log message.
- The `beforeSend` algorithm must be readable — split into named helpers if it's getting nested.
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
- Run `npm test`. Baseline before this phase: 383 tests. Phase 8a adds tests for the SentryService (no-op behavior, capture-with-tags behavior, PII scrubbing). Estimated ~10 new tests.
- BullMQ, Voyage, Qdrant, Anthropic, AND Sentry should all be mocked. No real DSN needed.

Testing requirements:
- run the project's standard test command
- report all failing tests clearly
- summarize results
- do not modify code or attempt fixes


STEP 5 — CODE REVIEW
Use the code-reviewer agent to review the implementation.

Review focus for this task:
- **Sentry init placement is correct** — at the top of `main.ts`, before `NestFactory.create`.
- **No-op behavior when DSN is absent** — verify by reading the SentryService init logic.
- **PII scrubbing in `beforeSend`** — every key in the brief's PII list is filtered. The algorithm is robust to nested structures.
- **`BadRequestException` is not captured** — verified by inspecting the filter mechanism.
- **Every KB catch block has a `sentryService.captureException` call added** with appropriate tags — including category and (where in scope) account_id and document_id.
- **Existing log lines are preserved** — Sentry capture is additive, not a replacement.
- **API keys, DSN values, and customer content (text, chunk_text, message) NEVER appear** in any log, throw, or Sentry event.
- **All existing tests still pass.** New tests cover the SentryService surface fully.
- **Out-of-scope respected** — no Slack hooks, no manual captures in non-KB code, no performance tracing, no user identification.

Review requirements:
- verify correctness of the implementation
- confirm alignment with the architectural plan
- evaluate maintainability, security, and performance
- ensure style refactor did not alter functionality
- report issues using structured review feedback
