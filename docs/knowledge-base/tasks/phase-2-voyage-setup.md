TASK OVERVIEW
Task name: Phase 2 — Voyage AI embedding service

Objective:
Add the Voyage AI embedding SDK as a dependency, create a typed NestJS service that wraps it with a clean two-method API surface (`embedText` for single strings, `embedTexts` for batches), and verify it end-to-end with unit-level tests. This service will be called at ingestion time (to embed document chunks) and at query time (to embed user questions) in later phases. Phase 2 only sets up the service — it is NOT wired into any ingestion endpoint or agent tool yet. When this phase is done, the app builds, tests pass, and a developer could manually invoke `voyageService.embedText("hello")` from a REPL and get back a number array.

Relevant context:
- This is a NestJS + TypeScript API. The established pattern for wrapping a third-party LLM/AI service as a NestJS provider is `src/services/anthropic.service.ts` paired with `src/services/anthropic-config.service.ts`. Study and mirror both.
- Voyage AI is Anthropic's partner embedding model provider. We will use `voyage-3-large` by default (highest retrieval quality). This model produces 1024-dimensional vectors (verify with the arch-planner via live docs).
- Voyage supports batch embedding — multiple texts per API call. The documented max batch size is 128 inputs per request (verify). Our service MUST handle arrays larger than that by auto-splitting into multiple sequential API calls and concatenating results, without requiring the caller to care.
- The official SDK package and its exact API signature must be verified against current Voyage docs. **The arch-planner MUST check the current state of the Voyage JS/TS SDK (context7 or WebFetch — `https://docs.voyageai.com/docs/introduction` and the package's npm page) before finalizing the plan. Do not rely on training-data knowledge.**
- Env vars: `VOYAGE_API_KEY` (required), `VOYAGE_MODEL` (optional, defaults to `voyage-3-large`).
- Per-phase scope limit: we are NOT calling this from any controller, agent, or tool in this phase. Those integrations come in Phase 4 (ingestion) and Phase 5 (retrieval).


STEP 1 — ARCHITECTURE PLANNING
Use the arch-planner agent to analyze the codebase and produce a structured implementation plan.

Task specifics for this plan:
- Confirm the exact npm package name for Voyage's JS/TS SDK, its current version, and the method signature for embedding text via live docs. If there is no official JS SDK or it is lacking, fall back to calling Voyage's REST API directly via `fetch` — in that case document the endpoint and request/response shapes in the plan.
- Design `src/services/voyage-config.service.ts` mirroring `src/services/anthropic-config.service.ts` exactly in shape (getters over `ConfigService`).
- Design `src/services/voyage.service.ts` mirroring `src/services/anthropic.service.ts` in shape. Public API:
  - `async embedText(text: string): Promise<number[]>` — embeds one string, returns one vector. Used at query time.
  - `async embedTexts(texts: readonly string[]): Promise<number[][]>` — embeds many strings, returns vectors in the same order. Used at ingestion time.
- Define how batch-splitting works internally: if `texts.length > BATCH_LIMIT` (128 or whatever Voyage documents), the service makes multiple sequential calls and concatenates results in order. The caller never sees this.
- Define the input-type parameter if Voyage supports it (e.g. `input_type: "document"` vs `input_type: "query"`). Currently we will default both methods to `"document"` but be prepared to expose an overload in a later phase. For Phase 2, keep it simple — no input-type parameter exposed to callers yet.
- Error handling:
  - Auth error / missing key → throw a clear error surfaced by the service, logged without leaking the key
  - Rate limit (429) → throw with a retryable marker; caller will decide whether to retry (we will NOT implement retry logic in this phase)
  - Network failure → throw with a clear error
  - All thrown errors should include enough context to debug without leaking the API key
- Smoke verification: unit test with SDK mocked, plus optionally a manual CLI or Nest command. No live API call in the automated suite.
- Update `src/config/configuration.ts` to expose a `voyage` namespace with `apiKey` and `model`.
- Update `src/config/env.validation.ts` to validate `VOYAGE_API_KEY` (required non-empty string) and `VOYAGE_MODEL` (optional string with a sane default).
- Register `VoyageConfigService` and `VoyageService` in `src/app.module.ts`.

Requirements for the plan:
- identify affected files/modules
- outline step-by-step implementation order
- note dependencies and architectural considerations
- list risks or edge cases (batch-limit edge, empty-input edge, API key missing in local dev)
- define testing strategy (unit tests with the SDK mocked; no network calls in CI)

Pause after producing the plan so I can review and approve it.


STEP 2 — IMPLEMENTATION
Use the code-implementer agent to implement the approved plan.

Implementation details for this task:
- Add the Voyage SDK (or fetch-based wrapper) dependency at the version confirmed by the arch-planner. Commit `package.json` and the lockfile.
- Create `src/services/voyage-config.service.ts` mirroring `anthropic-config.service.ts` in structure and style. Expose `apiKey` and `model` getters. Default `model` to `"voyage-3-large"` if not set.
- Create `src/services/voyage.service.ts` mirroring `anthropic.service.ts` in structure and style. Implement `embedText` and `embedTexts`. Internally, `embedText` should delegate to `embedTexts([text])[0]` to avoid duplicate code paths.
- Implement batch splitting: define a named constant `VOYAGE_MAX_BATCH` (use the value confirmed by the arch-planner). When input is larger, split into sequential calls and concatenate.
- Update `src/config/configuration.ts` to expose the `voyage` namespace.
- Update `src/config/env.validation.ts` to validate the Voyage env vars.
- Register both classes in `src/app.module.ts`.
- Update `.env.local` with placeholder lines (`VOYAGE_API_KEY=` and `# VOYAGE_MODEL=voyage-3-large`) without committing real keys.

Implementation requirements:
- follow the plan produced by the arch-planner agent
- modify or create only the necessary files
- respect existing architecture and coding patterns
- focus on correctness first (style will be handled later)


STEP 3 — STYLE REFACTOR
Use the style-refactor agent to refactor the implementation according to the rules defined in `.claude/instructions/style-enforcer.md`.

Style refactor specifics:
- `VoyageConfigService` and `VoyageService` must be structurally indistinguishable in style from their Anthropic siblings. Read `src/services/anthropic-config.service.ts` and `src/services/anthropic.service.ts` first and use them as the reference.
- Named constants for model default and batch limit (no magic numbers or strings in the method bodies).
- Log lines should follow the existing key=value bracketed format used elsewhere (`list-services.tool.ts`, `tool-registry.service.ts`).
- API keys must never appear in logs or thrown error messages.
- No `any`, no dead code, no placeholder comments.

Style requirements:
- apply all rules from style-enforcer.md
- improve readability, structure, and consistency
- align code with project conventions and standards
- do not change functionality or logic
- do not introduce new behavior


STEP 4 — TEST EXECUTION
Use the test-suite-runner agent to execute the project's test suite.

Testing context for this task:
- Run `npm run build` to confirm types are clean.
- Run `npm test` to confirm unit tests pass. Expected new tests:
  - `VoyageConfigService` spec: mocks `ConfigService`, asserts `apiKey` and `model` reads, asserts default `model` when unset.
  - `VoyageService` spec: mocks the SDK (or the fetch layer), covers:
    - `embedText` returns a single vector.
    - `embedTexts` with N < batch limit makes one API call.
    - `embedTexts` with N > batch limit makes multiple sequential calls and concatenates in order.
    - Empty input (`[]`) returns `[]` without calling the SDK.
    - Auth failure throws with a clear error and no API key leakage.
- Do not attempt to call the real Voyage API in tests. All tests must be fully mocked.

Testing requirements:
- run the project's standard test command
- report all failing tests clearly
- summarize results
- do not modify code or attempt fixes


STEP 5 — CODE REVIEW
Use the code-reviewer agent to review the implementation.

Review focus for this task:
- Does the Voyage service pattern match the Anthropic service pattern exactly? Any structural drift is a bug.
- Is the public API surface clean — just `embedText` and `embedTexts`? Are they correctly typed (readonly arrays where appropriate, `Promise<number[]>` / `Promise<number[][]>` returns)?
- Is batch splitting correct for edge cases: empty input, exactly batch-limit inputs, batch-limit+1 inputs, very large inputs?
- Is the API key never logged, never included in thrown error messages, never exposed via any public method?
- Is the SDK version pinned to the one the arch-planner confirmed via live docs?
- Are there any accidental calls from outside this module? There should be zero callers of `VoyageService` in this phase — it is a standalone dependency-free service.

Review requirements:
- verify correctness of the implementation
- confirm alignment with the architectural plan
- evaluate maintainability, security, and performance
- ensure style refactor did not alter functionality
- report issues using structured review feedback
