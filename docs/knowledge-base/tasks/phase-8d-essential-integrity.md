TASK OVERVIEW
Task name: Phase 8d-essential — Integrity hardening (v1-essential subset)

Objective:
Close the two real correctness gaps in the knowledge-base pipeline before the v1 stamp-of-approval. The full Phase 8d as scoped in `docs/knowledge-base/phase-8-considerations.md` is a bundle of operational hardening items deferred from earlier phases; most are post-launch concerns at v1 volumes. This sub-phase ships the **two v1-essential items** — the items that prevent silent KB contamination or catastrophic-but-rare failure modes — and explicitly defers the rest until production data justifies them.

This sub-phase formalizes a strategic decision the user locked in: the existing Jest test suite plus a forthcoming Playwright API test suite are the v1 contract. Everything in this sub-phase is non-negotiable for v1 because it directly attacks the integrity of that contract — without it, future regressions could leave silent corruption in customer knowledge bases that no test would catch and no operator would notice until retrieval quality visibly degraded.

When this phase is done:
- A startup probe in `VoyageService` (or a dedicated boot-check) embeds a known input, asserts the returned vector length matches the Qdrant collection's configured dimension (1024 for `voyage-3-large`), and refuses to boot on mismatch.
- All new Qdrant point IDs are deterministically derived from `(accountId, documentId, chunkIndex)` via UUIDv5. Re-ingesting or updating a document cleanly upserts via Qdrant's native point-ID semantics — no orphans on partial failure, no doubling on retry.
- Existing tests pass. New tests cover: dim-guard pass/fail at boot, deterministic ID generation (same tuple → same UUID; different tuple → different UUID), and retry idempotency (running the worker twice produces the same Qdrant state).
- Sentry receives a clear, tagged event when the dim guard fails at boot (`category: "voyage-dim-guard"`, severity fatal). The app does not start.

Relevant context:
- The KB pipeline today: ingestion API → DDB metadata write → BullMQ job enqueue → worker chunks → enriches via Anthropic → embeds via Voyage → writes to Qdrant. Update flow re-runs the same path with prior chunks deleted from Qdrant first. Phase 7a shipped update + delete; Phase 7b shipped enrichment; Phase 7c shipped the async queue.
- The existing per-account isolation invariant must NOT be broken. Every Qdrant query carries an `account_id` filter; deterministic IDs MUST include `accountId` in the input tuple so collisions across accounts are mathematically impossible.
- The existing Qdrant collection is configured for 1024-dimensional vectors (Voyage `voyage-3-large`). The dim guard hard-codes this dimension as the expected value, sourced from the same config that drives the collection setup. If `VOYAGE_MODEL` is ever changed, the dim guard's expected dimension must also change — both should derive from the same source of truth.
- **No mass migration of existing Qdrant points.** Points ingested before this phase have random UUIDs. We do NOT mass-migrate. Reasons: (1) migration costs Voyage embeddings on a corpus that may include stale data, (2) the deterministic IDs only matter for retry/update correctness — pre-existing read-only points retrieve fine, (3) any document that gets updated post-this-phase will have its old random-UUID chunks deleted (existing delete-by-document_id) and re-ingested with deterministic IDs, naturally migrating itself. The hybrid state (random IDs for never-updated docs, deterministic IDs for everything else) is acceptable and self-healing.
- **Why no in-flux compensation marker is needed.** With deterministic IDs in place, the existing update flow (delete-by-document_id → embed new chunks → upsert with deterministic IDs) becomes naturally idempotent. Every crash point during an update produces a state where retry-from-scratch yields clean results: delete-by-document_id is idempotent, embeds are deterministic given the same input, and upsert with deterministic IDs cannot create duplicates. A separate in-flux marker would only matter if the worker's retry behavior were more complex than "redo from scratch" — which it is not.

Key contracts (locked by the user before this brief — do not relitigate):

**Two work items, both v1-blocking:**

1. **Voyage dimension runtime guard at boot** — startup probe, asserts vector length matches expected, refuses to boot on mismatch.
2. **Deterministic Qdrant point IDs** — UUIDv5 derived from `(accountId, documentId, chunkIndex)`. New writes only; pre-existing points are NOT migrated.

**Voyage dim guard — locked details:**
- Probe input: a constant fixed string (e.g., `"voyage-dimension-probe"` — short, deterministic, never changes).
- Probe is called once at app startup, AFTER DI is initialized, BEFORE the app starts accepting traffic.
- On length mismatch: `Logger.error` with `[event=boot_failed reason=voyage_dim_mismatch expected=1024 actual=<n>]`, capture to Sentry with `tags: { category: "voyage-dim-guard", severity: "fatal" }`, then `process.exit(1)`. App does not boot.
- On Voyage outage at boot: 2 retries with linear backoff (1s, 2s). If still failing after 2 retries, log a CLEAR error (`[event=boot_failed reason=voyage_unreachable]`), capture to Sentry, exit. Local dev with no Voyage credentials configured is NOT a special case — `VOYAGE_API_KEY` is required at boot already; if it's set, the probe must succeed.
- Expected dimension is sourced from a single named constant (e.g., `EXPECTED_VOYAGE_DIMENSION = 1024`) co-located with the Qdrant collection setup config. If both ever need to change, they change together in one file.

**Deterministic Qdrant point IDs — locked details:**
- Algorithm: UUIDv5 with a project-specific namespace UUID (constant, generated once and committed in code) + name string `${accountId}:${documentId}:${chunkIndex}`. The `uuid` npm package is the standard implementation; check if already a dependency.
- The namespace UUID is generated once via `crypto.randomUUID()`, hardcoded as a named constant (`KB_POINT_ID_NAMESPACE`), and never changes. Changing it would invalidate every existing deterministic point ID — treat it like a version-1 schema commitment.
- Same `(accountId, documentId, chunkIndex)` always produces the same UUID, anywhere in the codebase, forever.
- Different inputs produce different UUIDs (UUIDv5 collision probability is negligible for our scale).
- Applied at the moment of Qdrant point construction (likely in the chunk-processing service or wherever points are batched for upsert). All call sites that previously used `crypto.randomUUID()` for point IDs are updated to use the deterministic helper.
- Migration: NOT applied retroactively. Pre-existing random-UUID points stay as-is. Any future update to those documents naturally migrates them via the existing delete-by-document_id + re-ingest flow.
- Naming: TypeScript-side variables use camelCase (`accountId`, `documentId`, `chunkIndex`). DDB-side fields use snake_case (`account_id`, `document_id`). The deterministic-ID helper accepts the camelCase TS variants.

**Out of scope for Phase 8d-essential (do not add):**
- In-flux / compensation marker on DDB records (explicitly removed from scope after analysis showed deterministic IDs alone make the update flow idempotent).
- Stuck-job detector (defer — important at production volume; at v1 volumes, Slack alerts from 8b plus customer reports surface stuck jobs faster than auto-detection earns its keep).
- Anthropic retry-with-backoff on 429 during enrichment (defer — the existing fall-through to "embed without enrichment" is a graceful degradation, not a correctness bug).
- Orphan-vector cleanup script (defer — once deterministic IDs ship, new orphans stop accumulating; existing orphans are read-only and harmless).
- GSI on `(account_id, external_id)` (defer per the considerations doc — explicitly "add when an account hits ~100 docs").
- Per-account ingestion concurrency cap (defer — Phase 8f).
- Per-account / per-plan ingestion limits (defer — Phase 8f).
- Document-level enrichment status field (defer — Phase 8f).
- Read-consistency during update (no partial-state visibility for retrievals mid-update) — needs a different mechanism (per-point version field + query filter); not v1-blocking; defer.
- Mass migration of existing random-UUID points to deterministic IDs (explicitly deferred — natural migration via update flow is acceptable).
- Request-level idempotency keys on the ingestion endpoint (out of scope — handled at the contract layer with the upstream caller).
- Any change to `/chat/web/*`, the iframe auth model, or the conversation runtime path. This phase is KB pipeline only.


STEP 1 — ARCHITECTURE PLANNING
Use the arch-planner agent to analyze the codebase and produce a structured implementation plan.

Task specifics for this plan:

1. Read this brief in full. Read `docs/knowledge-base/phase-8-considerations.md` (specifically the 8d section) and `docs/knowledge-base/HANDOFF.md` for the orchestration contract. Read `docs/knowledge-base/data-flows.md` for the pipeline architecture (ingestion, update, delete paths) — this brief depends on knowing exactly where in those flows each work item plugs in.

2. Study the existing patterns the new code must mirror or extend:
   - `src/services/voyage.service.ts` — the embedding service. The dim guard probe is a new method here OR a separate boot-check service that calls `embedText`. Inspect to recommend the cleaner option.
   - `src/providers/qdrant.provider.ts` (or wherever the Qdrant collection setup lives) — the source of truth for the configured collection dimension (1024). The `EXPECTED_VOYAGE_DIMENSION` constant is co-located with this.
   - The chunk-processing service / BullMQ worker — wherever Qdrant points are constructed for upsert today. This is where `crypto.randomUUID()` for point IDs is replaced with the deterministic helper.
   - `src/instrument.ts` Sentry setup — confirm the existing `category` tagging convention so the dim-guard event is consistent.
   - `src/main.ts` — startup sequencing. The dim guard must run AFTER NestFactory.create completes (DI resolved) and BEFORE app.listen.
   - `package.json` — confirm whether `uuid` is already a dependency (likely yes — used in many NestJS projects). If not, the implementer adds it.

3. Verify against current docs:
   - **Voyage embed contract**: confirm the request shape, the response shape (specifically the embedding vector length for `voyage-3-large`), and timeout/retry behavior. Source: Voyage AI API docs.
   - **Qdrant point ID semantics**: confirm UUID format support (Qdrant accepts integer OR UUID, both are valid) and confirm `upsert` semantics (same point ID overwrites cleanly). Source: Qdrant docs for the version pinned in `package.json`.
   - **UUIDv5 implementation**: confirm the `uuid` npm package's `uuidv5(name, namespace)` API, including the namespace UUID format constraint. Source: `uuid` package README.

4. Produce a detailed implementation plan covering ALL of these sections:
   - **Overview** — one paragraph.
   - **Affected files / modules** — comprehensive list with one-line note per file.
   - **Voyage / Qdrant / UUID contract verification findings** — confirmed contract details with source URLs.
   - **Dim-guard design** — exact location (new file or method on existing service?), exact probe input string, exact retry logic, exact failure path (Logger.error + Sentry capture + process.exit(1)), exact wiring point in `src/main.ts`. Specifically: should this be a new `BootCheckService` with a method called from `main.ts`, or a method on `VoyageService` called from an `OnModuleInit` lifecycle hook? Pick one and justify.
   - **Deterministic point ID design** — exact helper function name and location (e.g., `src/utils/qdrant-point-id.ts`), exact UUIDv5 namespace constant (a fresh UUID generated by the planner via `crypto.randomUUID()` and hardcoded), exact name-string format (`${accountId}:${documentId}:${chunkIndex}`), exact list of call sites that change today.
   - **Step-by-step implementation order** — file-by-file. Order matters: helper utility → service updates → call-site swaps → tests.
   - **Testing strategy:**
     - Dim-guard spec: pass case (correct dim → no throw), fail case (wrong dim → throw + Sentry capture), retry case (transient Voyage failure → retries → succeeds), exhaust case (3 failures → boot fails). Mock `VoyageService.embedText` (no real API calls in tests).
     - Deterministic point ID spec: same input → same UUID; different inputs → different UUIDs (validate `accountId` change, `documentId` change, `chunkIndex` change all produce different IDs); namespace constant is stable (test fixture asserts it equals the hardcoded value).
     - Retry idempotency spec: simulate a worker that runs an ingestion to completion, then runs the same ingestion again with the same input — Qdrant state is identical (verified via `upsert` call assertions and final chunk count).
   - **Risks and edge cases:**
     - Boot-time Voyage outage blocking the app from starting at all — document the operational impact and the 2-retry mitigation.
     - Namespace UUID accidentally regenerated by a future contributor — the constant must have a clear comment that changing it invalidates every existing point ID. Worth a comment in code AND a note in `docs/knowledge-base/data-flows.md`.
     - Existing Qdrant points with random UUIDs co-existing with new deterministic ones — confirm this is fine for retrieval (it is, since both are valid Qdrant point IDs and retrieval doesn't care about the ID structure).
     - Dim-guard adds startup latency — document the expected probe cost (~one Voyage embed call, typically <500ms). If Voyage is healthy this is invisible; if it's not, the app waits up to ~3s before bailing. Acceptable.
   - **Out-of-scope confirmations.**

5. Write your plan to `docs/knowledge-base/tasks/phase-8d-essential-integrity-plan.md`.

6. Return a concise summary (under 600 words) including:
   - Path to the plan file
   - 5–7 key decisions or clarifications you made — particularly around (a) where the dim guard wires into startup, (b) where the deterministic ID helper lives and exactly which call sites change, (c) whether `uuid` is already a dependency or needs to be added, (d) the namespace UUID you generated for `KB_POINT_ID_NAMESPACE`, (e) the exact source-of-truth file for `EXPECTED_VOYAGE_DIMENSION`
   - Any risks, unknowns, or "needs orchestrator decision" items the user should resolve before approval

Hard rules for this agent:
- DO NOT commit. DO NOT push. DO NOT run any `git` write command.
- DO NOT read `.env`, `.env.local`, or any `.env.*` file. Only `.env.example` if it exists.
- Pause after producing the plan so the orchestrator can get user approval before Step 2.


STEP 2 — IMPLEMENTATION
Use the code-implementer agent to implement the approved plan.

Implementation details for this task:
- Implement the dim guard exactly as the plan specifies (location, retry logic, failure path, Sentry tags, process.exit(1) on terminal failure).
- Implement the deterministic point ID helper as a pure function in a single utility file. Replace every existing `crypto.randomUUID()` call site for Qdrant points with the new helper. Do NOT replace `randomUUID` calls used for non-Qdrant purposes (session IDs, etc.).
- Add tests per the plan's testing strategy. Mock all external services (Voyage, Qdrant, DDB). No real network calls in tests.
- Run `npm run build` and `npm test` before returning.

Implementation requirements:
- follow the plan produced by the arch-planner agent
- modify or create only the necessary files
- respect existing architecture and coding patterns
- focus on correctness first (style will be handled later)

Hard rules for this agent:
- DO NOT commit. DO NOT push. DO NOT run any `git` write command. The orchestrator commits at sub-phase boundary, only after explicit user approval.
- DO NOT read `.env`, `.env.local`, or any `.env.*` file. Only `.env.example` if it exists.


STEP 3 — STYLE REFACTOR
Use the style-refactor agent to refactor the implementation according to the rules defined in `.claude/instructions/style-enforcer.md`.

Style refactor specifics:
- The new helper function (deterministic point ID) is a pure utility — keep it terse, well-named, and free of side effects.
- Bracketed `[key=value]` log format throughout the dim-guard logging.
- Named constants for: the probe input string, the expected dimension, the namespace UUID, the retry count + backoff intervals. No magic strings or numbers.
- Mark the namespace UUID constant clearly as "DO NOT change without a coordinated migration" — this is a correctness comment, not a "what" comment.
- TypeScript-side naming follows existing project conventions (camelCase for variables, no `Ulid` suffix on type or variable names).
- No `any`, no inline type annotations TypeScript can infer, no dead code, no placeholder comments.
- Do NOT undo any change made by the implementer that resolves a previous-round style finding (consistent with the Phase 8c lesson — re-removing reviewer-approved changes is a regression).

Style requirements:
- apply all rules from style-enforcer.md
- improve readability, structure, and consistency
- align code with project conventions and standards
- do not change functionality or logic
- do not introduce new behavior

Hard rules for this agent:
- DO NOT commit. DO NOT push. DO NOT run any `git` write command.
- DO NOT read `.env`, `.env.local`, or any `.env.*` file. Only `.env.example` if it exists.


STEP 4 — TEST EXECUTION
Use the test-suite-runner agent to execute the project's test suite.

Testing context for this task:
- Run `npm run build` first.
- Run `npm test`. Baseline before this phase: 460 tests. Phase 8d-essential adds tests for: dim-guard (4 cases), deterministic point ID helper (~5 cases), retry idempotency (~3 cases). Estimated new total: ~470–475.
- Mock all external services (Voyage, Qdrant, DDB). Tests must NOT make real network calls.

Testing requirements:
- run the project's standard test command
- report all failing tests clearly
- summarize results
- do not modify code or attempt fixes

Hard rules for this agent:
- DO NOT commit. DO NOT push. DO NOT run any `git` write command.
- DO NOT read `.env`, `.env.local`, or any `.env.*` file.
- DO NOT modify any source or test file.


STEP 5 — CODE REVIEW
Use the code-reviewer agent to review the implementation.

Review focus for this task:
- **Dim guard runs AT BOOT, BEFORE the app accepts traffic.** Verify the wiring point is correct (after DI resolution, before `app.listen`). A guard that runs after `app.listen` is a regression — the app would accept traffic with a corrupt embedding pipeline.
- **Dim guard FAILS the boot on mismatch.** No fallback, no warning-and-continue, no "skip in dev." The whole point is to refuse to start when the contract is violated.
- **Deterministic IDs include `accountId`.** Per-account isolation is the load-bearing invariant. A point ID derived only from `(documentId, chunkIndex)` would let two accounts collide. Confirm the helper signature requires accountId.
- **Namespace UUID is hardcoded and clearly documented** as immutable. Search for any code path that regenerates it dynamically — if found, that's a critical bug.
- **Every existing `crypto.randomUUID()` call site for Qdrant points is replaced.** Re-enumerate from source; missed call sites would create non-deterministic points alongside deterministic ones. Non-Qdrant random UUID usage (session IDs, etc.) is left alone.
- **Retry idempotency is verifiable.** A test exists confirming that running the worker twice with the same input produces the same Qdrant state. If absent, this phase has not actually proven the integrity claim.
- **Per-account isolation is unaffected.** This phase doesn't touch account filtering. Confirm.
- **Sentry receives the dim-guard failure with the correct tags.** The boot failure must be visible in Sentry; otherwise an outage during deployment is silent.
- **`/chat/web/*` is not touched.** Confirm.
- **TypeScript naming convention** — verify camelCase for variables and no `Ulid` suffix on type/variable names. DDB-side snake_case for stored fields is unchanged.
- **Out-of-scope respected** — no in-flux marker, no stuck-job detector, no Anthropic retry-with-backoff, no orphan cleanup script, no GSI, no concurrency cap, no per-plan limits, no enrichment status field, no mass migration script.

Review requirements:
- verify correctness of the implementation
- confirm alignment with the architectural plan
- evaluate maintainability, security, and performance
- ensure style refactor did not alter functionality
- report issues using structured review feedback

Hard rules for this agent:
- DO NOT commit. DO NOT push. DO NOT run any `git` write command.
- DO NOT read `.env`, `.env.local`, or any `.env.*` file.
- DO NOT modify any source file.
