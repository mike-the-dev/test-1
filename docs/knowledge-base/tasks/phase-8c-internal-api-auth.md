TASK OVERVIEW
Task name: Phase 8c — Internal-API authentication (shared-secret guard for server-to-server callers)

Objective:
Lock down the `/knowledge-base/*` HTTP surface so only authenticated upstream servers can call it. Today these endpoints are fully open. After this phase, every call must present a valid `X-Internal-API-Key` header matching the value of the `KB_INTERNAL_API_KEY` env var. The guard is built as a reusable, **one-line decorator** so any future server-to-server controller (operational endpoints in 8e, future enrichment/moderation/admin controllers, etc.) can adopt the same protection trivially.

This phase formalizes a strategic commitment about the API's identity that the user locked in during brainstorming: **this NestJS service is an internal-only "conversation engine" and is never reached directly by end users.** It has exactly two classes of caller — (1) the iframe-facing web chat endpoints (which have their own per-conversation auth model and are NOT touched by this guard), and (2) trusted upstream servers (the existing ecommerce API today; future partners tomorrow) speaking server-to-server. There is no third class. There will never be direct user authentication on this API. Phase 8c hard-codifies that boundary.

When this phase is done:
- A reusable `InternalApiKeyGuard` (`src/guards/internal-api-key.guard.ts`) protects every server-to-server endpoint via a single `@UseGuards(InternalApiKeyGuard)` decoration.
- A typed `InternalApiAuthConfigService` exposes the `KB_INTERNAL_API_KEY` value via the existing `ConfigService` chain, mirroring `AnthropicConfigService` / `SentryConfigService` exactly.
- `KB_INTERNAL_API_KEY` is required at boot — the app refuses to start if it's unset in any environment. Local dev sets it in `.env.local`; CI sets it in test env; staging/prod set it via deployment env config.
- All existing `/knowledge-base/*` endpoints (POST `/knowledge-base/documents`, DELETE `/knowledge-base/documents/:id`, plus any others discovered by the arch-planner) are protected. The iframe-facing `/chat/web/*` endpoints are explicitly unaffected.
- Header secret is compared in **constant time** via `crypto.timingSafeEqual` — never `===`, never `==`, never anything that short-circuits.
- The header value never appears in logs, error messages, thrown exceptions, or Sentry events. Sentry's `beforeSend` scrubber (added in 8a) is extended to redact the `x-internal-api-key` header by name.
- All existing tests still pass; new tests cover the guard surface (missing header, wrong header, correct header, timing-safe comparison shape) and the config service (loaded value, refuses to boot when unset).

Relevant context:
- The reusable `InternalApiKeyGuard` is the **only** chokepoint that knows how to verify the shared secret. Adding a future server-to-server controller = one decorator on the controller. Replacing the secret model later (per-partner key registry, mTLS, etc.) = swap the implementation behind the same guard class — no caller changes.
- Pattern is **opt-in via `@UseGuards`** at the controller level for v1, NOT a global guard with `@Public()` opt-outs. Reasons:
  - Smaller blast radius on first ship — only KB endpoints change behavior.
  - Existing `/chat/web/*` endpoints continue working with zero modification.
  - Default-secure (global + opt-out) can be a future enhancement once the codebase grows enough server-to-server surface to justify it.
- The configuration chain mirrors every existing service (`InternalApiAuthConfigService` → `configuration.ts` → `env.schema.ts` → `.env.local`), identical in shape to `AnthropicConfigService`, `SentryConfigService`, etc.
- `KB_INTERNAL_API_KEY` is a **brand-new secret distinct from any existing JWT signing secret on the upstream ecommerce API**. The two values share a name space conceptually (one half lives on each server) but have completely different purposes:
  - Ecommerce API's JWT secret: signs user JWTs. Lives only on the ecommerce API. Never enters this repo.
  - `KB_INTERNAL_API_KEY`: server-to-server handshake. Lives on both servers (ecommerce API reads it to send the header; chat-session-api reads it to verify the header). Generated fresh via `openssl rand -base64 48` (or equivalent 32+ byte entropy source).
- v1 ships **a single global key**. The user has explicitly declined a per-partner key registry — when partner #2 onboards, they'll get their own deployment of this API with its own `KB_INTERNAL_API_KEY`. If/when that becomes operationally awkward, the guard's internal logic graduates to a key registry behind the same external interface.
- HTTPS-only is assumed at the deployment layer. The guard does NOT additionally verify TLS — that's an infrastructure concern, not an application concern. (Document this assumption clearly in the implementation comments / plan.)
- Per-account isolation is unaffected by this phase. The guard answers "is this caller trusted?" — it does NOT answer "which account are they acting on behalf of?" That latter question is still answered by the `account_id` field in the request body / path / query, exactly as today. The two checks are orthogonal and both must pass.

Key contracts (locked by the user before this brief — do not relitigate):

**Header name (locked):** `X-Internal-API-Key`
- Reason: explicitly distinct from `Authorization: Bearer <jwt>` used for user JWTs in the upstream ecommerce API. Visual separation prevents accidentally routing a user token into the wrong validator.
- Case-insensitive lookup (HTTP header semantics — most frameworks normalize to lowercase internally; the guard reads `x-internal-api-key`).

**Env var (locked):** `KB_INTERNAL_API_KEY`
- Required at boot. App refuses to start if unset (no env-dependent special cases — dev/test/staging/prod all require it set).
- Loaded via the standard `env.schema.ts` → `configuration.ts` → typed `InternalApiAuthConfigService` chain.
- Minimum length validation in `env.schema.ts`: at least 32 characters (sanity guard against accidental short values; real keys generated via `openssl rand -base64 48` will be 64 characters).

**Comparison (locked):** `crypto.timingSafeEqual` against UTF-8 buffers of equal length.
- If the incoming header is missing, reject with `UnauthorizedException` (no comparison performed).
- If the incoming header is present but a different length than the configured secret, reject with `UnauthorizedException` (no comparison performed — `timingSafeEqual` requires equal-length buffers and would throw).
- Only when both buffers exist and are the same length is `timingSafeEqual` invoked.

**Application strategy (locked):** Controller-level `@UseGuards(InternalApiKeyGuard)` decoration on every server-to-server controller.
- v1 application sites: every controller under the `/knowledge-base/*` HTTP surface. The arch-planner enumerates the full list.
- Explicitly NOT applied to: `/chat/web/*` controllers (iframe-facing — out of scope; different auth model already in place).
- Future controllers (Phase 8e endpoints, hypothetical enrichment/moderation/admin endpoints) inherit the same pattern by adding the same decorator. Document this convention near the guard so the next contributor finds it without searching.

**Failure handling (locked):**
- Missing header → `UnauthorizedException` with body `{ "statusCode": 401, "message": "Unauthorized" }`. Do NOT include any hint about *why* the request was unauthorized in the response body. (Reason: don't help an attacker enumerate "is the header missing or wrong?")
- Wrong header → identical `UnauthorizedException` shape. Indistinguishable from missing-header from the caller's perspective.
- Boot with missing env var → app fails to start. Log line at startup makes the cause obvious: `[event=boot_failed reason=missing_required_env var=KB_INTERNAL_API_KEY]`. Throw via the standard NestJS config validation pipeline (Joi/Zod schema enforces presence + min length).

**Logging (locked):**
- On rejection: `Logger.warn` with bracketed `[event=internal_auth_rejected reason=missing_header path=<route>]` or `[event=internal_auth_rejected reason=invalid_key path=<route>]`.
- On accept: do NOT log per-request acceptance (would be noise on a hot path). Authorized requests proceed silently.
- The header **value** never appears in any log line, ever. Only the boolean outcome plus the reason category.

**Sentry scrubbing (locked):**
- Update the existing `beforeSend` scrubber added in Phase 8a to redact the `x-internal-api-key` header from any captured event's request context. Use the same pattern already in place for whatever PII fields are scrubbed today.
- Add a unit test confirming the scrubber strips this header even when present in a captured event.

**Out of scope for Phase 8c (do not add):**
- mTLS or any TLS-layer authentication. Document as a future upgrade in `phase-8-considerations.md` if the user requests; otherwise leave the existing 8c → mTLS note as-is.
- Per-partner key registry, key rotation tooling, or any in-app key management. Single global key only for v1.
- JWT verification for upstream user tokens. The upstream caller (ecommerce API) is responsible for verifying user JWTs on its side and stamping the resolved `account_id` into the request body before calling this API.
- Direct user authentication on this API. There are no users on this API; there are only callers.
- Rate limiting, IP allowlisting, or any other request-shape constraint. Single concern: "is this caller trusted via shared secret."
- Touching `/chat/web/*` controllers in any way. The iframe-facing surface keeps its existing auth model (domain allowlist + per-conversation context) untouched.
- Generating, distributing, or rotating the actual secret value. That's an operations task — this phase ships the mechanism, not the key.
- OpenAPI / Swagger security scheme additions, unless the project already uses Swagger and the arch-planner finds the integration trivial. (If non-trivial, defer.)


STEP 1 — ARCHITECTURE PLANNING
Use the arch-planner agent to analyze the codebase and produce a structured implementation plan.

Task specifics for this plan:

1. Read this brief in full. Read `docs/knowledge-base/phase-8-considerations.md` (specifically the 8c section) and `docs/knowledge-base/HANDOFF.md` to understand where 8c sits in the broader Phase 8 roadmap and the orchestration contract.

2. Study the existing patterns the new code must mirror:
   - `src/services/anthropic-config.service.ts`, `src/services/sentry-config.service.ts` — the typed config service pattern. New `InternalApiAuthConfigService` is a copy-paste with field renames.
   - `src/config/configuration.ts` and `src/config/env.schema.ts` — the env loader chain. Add `internalApiAuth.key` (or whatever the existing namespace convention is) to `configuration.ts` and `KB_INTERNAL_API_KEY` to `env.schema.ts` with `min(32)` validation.
   - `src/guards/` — the existing guard folder. Inspect any existing guards (if any) to match style. If empty, the new guard establishes the convention.
   - `src/controllers/` — enumerate every controller under `/knowledge-base/*`. Confirm the full set of routes that need protection. Identify any tests that exercise these endpoints and will need a `KB_INTERNAL_API_KEY` test fixture / mock.
   - `src/services/sentry.service.ts` and the `beforeSend` scrubber added in 8a — confirm where to add the `x-internal-api-key` redaction.
   - Log-line format: bracketed `[key=value key=value]` everywhere.

3. Verify the NestJS guard contract against current docs:
   - `CanActivate` interface, `ExecutionContext` shape, accessing the underlying request via `context.switchToHttp().getRequest()`.
   - How to throw `UnauthorizedException` so it produces the standard 401 response body.
   - How to combine multiple guards on the same controller (in case a future controller needs both this guard and another).
   - Source: NestJS Guards documentation (verify currency — major version of `@nestjs/common` in `package.json`).

4. Verify Node's `crypto.timingSafeEqual` semantics:
   - Throws when buffers are unequal length — confirm the guard handles this by length-checking first.
   - UTF-8 encoding of both header value and configured secret into `Buffer` instances.
   - Source: Node.js `crypto` module documentation for the major Node version in `package.json` / `.nvmrc`.

5. Produce a detailed implementation plan covering ALL of these sections:
   - **Overview** — one paragraph.
   - **Affected files / modules** — comprehensive list with one-line note per file.
   - **NestJS guard verification findings** — confirmed contract details with source URLs.
   - **`InternalApiKeyGuard` design** — exact class shape, including:
     - Constructor injection of `InternalApiAuthConfigService`.
     - `canActivate` implementation: extract header → null/length check → constant-time compare → return true OR throw `UnauthorizedException`.
     - Logger.warn call shape on rejection (bracketed format, no key value).
     - Private helper that performs the comparison (kept narrow and unit-testable).
   - **`InternalApiAuthConfigService` design** — exact getter shape mirroring `AnthropicConfigService`. Should be a non-optional `string` getter (env validation guarantees presence).
   - **Env-loader changes** — exact additions to `env.schema.ts` (Zod or Joi schema entry with `min(32)`) and `configuration.ts` (namespaced key).
   - **Sentry `beforeSend` extension** — exact code change to the existing scrubber that adds `x-internal-api-key` redaction. Cite the file and the function being modified.
   - **Per-controller decoration plan** — list every `/knowledge-base/*` controller class file the implementer will touch, and the exact `@UseGuards(InternalApiKeyGuard)` decoration to add. Confirm each one is a controller-level decoration (not method-level) so newly added methods on those controllers inherit protection automatically.
   - **Module registration** — what gets added to `app.module.ts` providers (the new config service; the guard if it needs to be a provider).
   - **Test fixture / mock strategy for existing tests** — every existing controller-level integration test that hits a `/knowledge-base/*` endpoint will start failing with 401 after this change unless updated. Enumerate the affected spec files and prescribe the fix (e.g., set a test `KB_INTERNAL_API_KEY` in a shared test setup, send the matching header in test requests). This is a non-trivial scope item — get it right.
   - **Step-by-step implementation order** — file-by-file, with the env-schema changes first (so the rest of the build doesn't break) and the per-controller decorations last (so we don't break tests until everything else is in place).
   - **Testing strategy:**
     - `InternalApiKeyGuard.spec.ts` — covers: missing header → 401; header with wrong length → 401 (with no `timingSafeEqual` call); header with same length, wrong content → 401 (with `timingSafeEqual` invoked); header with correct value → returns true; verify `timingSafeEqual` is the comparison primitive (not `===`). Use mocked `ExecutionContext`.
     - `InternalApiAuthConfigService.spec.ts` — covers: getter returns the configured value; throws / fails-fast when unset (or document that env-schema validation handles this and the service trusts presence).
     - Controller-level integration tests — every existing KB controller spec needs to be updated to include the header. Add at least one test per controller verifying that requests WITHOUT the header return 401 (defense in depth — confirms the decoration is in place).
     - Sentry scrubber spec extension — confirms `x-internal-api-key` is redacted from a captured event's request context.
   - **Risks and edge cases:**
     - Forgetting to update an existing test fixture → CI fails. Mitigation: enumerate every affected spec in the plan; the implementer touches all of them in the same change.
     - Future contributor adds a new `/knowledge-base/*` route or controller and forgets the decoration → silent regression. Mitigation: add a brief code comment near the guard explaining the convention; consider a test that asserts every controller in a known directory has the decoration (out of scope for v1 but worth a note).
     - HTTPS termination assumption documented but not enforced in code — make sure the plan flags this as a deployment-config dependency.
     - Header-value leakage via Express request logging middleware (if any exists) — the arch-planner verifies whether any such middleware logs full request headers. If yes, add the same redaction there.
   - **Out-of-scope confirmations.**

6. Write your plan to `docs/knowledge-base/tasks/phase-8c-internal-api-auth-plan.md`.

7. Return a concise summary (under 600 words) including:
   - Path to the plan file
   - 5–7 key decisions or clarifications you made — particularly around (a) which controllers/routes get decorated (the full enumerated list), (b) the existing-test-fixture migration strategy, (c) the Sentry scrubber extension specifics, (d) whether any other request-logging middleware needs header redaction
   - Any risks or unknowns the orchestrator should flag to the user before approval

Pause after producing the plan so the orchestrator can get user approval before Step 2.


STEP 2 — IMPLEMENTATION
Use the code-implementer agent to implement the approved plan.

Implementation details for this task:
- Add `KB_INTERNAL_API_KEY` to `env.schema.ts` with `min(32)` validation. Add to `.env.example` (or equivalent template) with a clear placeholder like `KB_INTERNAL_API_KEY=replace-with-openssl-rand-base64-48-output`.
- Add the namespaced entry in `configuration.ts`.
- Create `InternalApiAuthConfigService` mirroring the existing config service style exactly.
- Create `InternalApiKeyGuard` in `src/guards/internal-api-key.guard.ts` with constant-time comparison via `crypto.timingSafeEqual`. Logger.warn on rejection (bracketed format, NEVER the header value).
- Apply `@UseGuards(InternalApiKeyGuard)` at the controller level on every `/knowledge-base/*` controller enumerated in the plan.
- Extend the existing Sentry `beforeSend` scrubber to redact the `x-internal-api-key` header from captured event request contexts.
- Update every existing `/knowledge-base/*` controller spec / integration test enumerated in the plan: set a test `KB_INTERNAL_API_KEY` value in shared test setup, send the matching header in test requests. Add at least one test per controller verifying that a request WITHOUT the header returns 401.
- Register the new config service (and guard, if needed) in `src/app.module.ts`.
- Local dev: add `KB_INTERNAL_API_KEY=local-dev-secret-replace-in-real-environments-only-but-must-be-min-32-chars` (or similar) to `.env.local` if that file exists; otherwise leave the developer to set it.
- The header value must NEVER appear in logs, thrown errors, or Sentry events.
- Run `npm run build` and `npm test` before returning.
- Commit on master. Suggested subject: `feat(security): add internal-API key guard for server-to-server KB endpoints`. **Do NOT add `Co-Authored-By:` or credit Claude.**

Implementation requirements:
- follow the plan produced by the arch-planner agent
- modify or create only the necessary files
- respect existing architecture and coding patterns
- focus on correctness first (style will be handled later)


STEP 3 — STYLE REFACTOR
Use the style-refactor agent to refactor the implementation according to the rules defined in `.claude/instructions/style-enforcer.md`.

Style refactor specifics:
- The new guard and config service files mirror existing service style exactly (constructor DI, logger, named constants, sanitized error handling).
- Bracketed `[key=value]` log format throughout.
- Header value NEVER in log lines, thrown errors, or test fixtures that get logged.
- Comparison helper inside the guard is a named private method, not an inline expression — keep it small and unit-testable.
- No `any`, no inline type annotations TypeScript can infer, no dead code, no placeholder comments.
- Test fixture for `KB_INTERNAL_API_KEY` is a clearly-fake value (e.g., `test-secret-32-chars-long-aaaaaaaa`) — do not use anything that looks like a real production secret.

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
- Run `npm test`. Baseline before this phase: ~430 tests (post-8b). Phase 8c adds tests for `InternalApiKeyGuard` (missing/wrong/right header, constant-time-compare invocation), `InternalApiAuthConfigService`, the Sentry scrubber extension, and a per-controller "no header → 401" test for every protected controller.
- Estimated new total: ~445–460 depending on per-controller test count.
- Every existing `/knowledge-base/*` integration test must continue to pass with the test fixture sending the matching header. If any such test fails because the fixture wasn't updated, that's a regression — flag it.

Testing requirements:
- run the project's standard test command
- report all failing tests clearly
- summarize results
- do not modify code or attempt fixes


STEP 5 — CODE REVIEW
Use the code-reviewer agent to review the implementation.

Review focus for this task:
- **Header value is never logged, never thrown, never captured to Sentry.** Search every `Logger.*` call, every `throw`, every error_summary, every `captureException` call. Confirm absence of the actual header value in any of them.
- **Constant-time comparison is in use.** Verify the guard uses `crypto.timingSafeEqual` on equal-length buffers, NOT `===` / `==` / `String.prototype === ...`. Confirm the length-check guard precedes `timingSafeEqual` so the function never throws on length mismatch.
- **App refuses to boot when `KB_INTERNAL_API_KEY` is unset** in any environment. Verify the env-schema validation enforces this. There should be NO conditional like "skip auth in dev" or "no-op when unset" — any such code is a regression.
- **Every `/knowledge-base/*` controller is decorated.** Re-enumerate from the source tree (don't trust the plan blindly) and confirm each one has the `@UseGuards(InternalApiKeyGuard)` decoration. Missing decorations are critical bugs.
- **No `/chat/web/*` controllers were touched.** The iframe-facing surface must remain unchanged. Confirm.
- **Sentry scrubber extension covers the new header.** Manually trace the `beforeSend` code path — confirm that `x-internal-api-key` is redacted from request context, request headers, and any breadcrumb data.
- **Per-account isolation is unchanged.** This phase doesn't touch `account_id` handling. Confirm the guard doesn't accidentally interfere with the existing per-account validation in any controller.
- **Test fixtures use clearly-fake values** — no real-looking secrets in test files.
- **Existing tests pass with the header included.** No `/knowledge-base/*` integration test was disabled, skipped, or left unprotected.
- **Out-of-scope respected** — no mTLS, no per-partner key registry, no JWT verification, no rate limiting, no IP allowlisting, no Swagger security scheme (unless trivially in scope), no changes to the iframe auth model.

Review requirements:
- verify correctness of the implementation
- confirm alignment with the architectural plan
- evaluate maintainability, security, and performance
- ensure style refactor did not alter functionality
- report issues using structured review feedback
