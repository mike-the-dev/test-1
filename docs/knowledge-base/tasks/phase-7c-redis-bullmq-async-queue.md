TASK OVERVIEW
Task name: Phase 7c — Redis + BullMQ async ingestion queue

Objective:
Refactor the ingestion endpoint from synchronous to asynchronous. Today, `POST /knowledge-base/documents` blocks the HTTP request for the full duration of the chunk → enrich → embed → write pipeline (16 seconds for a 15-chunk document; potentially minutes for 100+ chunk documents). Phase 7c moves the actual work into a background BullMQ worker backed by Redis: the POST writes a `pending` record to DynamoDB, queues the job, and returns `202 Accepted` immediately. The upstream control-panel API then polls a new status endpoint to know when processing has flipped to `ready` or `failed`.

When this phase is done:
- `POST /knowledge-base/documents` returns within ~100 ms regardless of document size, with HTTP `202 Accepted` and `{ document_id, status: "pending" }`.
- A background worker picks up the queued job within seconds, runs the existing Phase 4–7b pipeline, and updates the DynamoDB record's `status` field through `processing` → `ready` (or `failed`).
- Upstream callers can poll a new `GET /knowledge-base/documents` endpoint (with `account_id` + `external_id` query params) to observe the status transition.
- DELETE remains synchronous (it's already fast — no Claude/Voyage calls).
- All existing tests still pass; new tests cover the queue-and-process flow, status transitions, retries, and Redis-unavailable handling.

Relevant context:
- This phase is a refactor + infrastructure addition, not a content change. It wraps the existing Phase 7b pipeline rather than modifying its logic.
- Read `docs/knowledge-base/data-flows.md` for the current synchronous shape of Flow 1 and Flow 3. Phase 7c modifies both significantly. The data-flows doc must be updated as part of this phase.
- The existing `KnowledgeBaseIngestionService.ingestDocument` becomes the body of the queue worker. The controller's POST handler stops calling it directly and instead enqueues a job.
- Redis is added as a new local dependency via `docker-compose.yml`, alongside the existing Qdrant container.
- BullMQ (the modern successor to Bull) is the queue library, accessed via `@nestjs/bullmq`. Install both `@nestjs/bullmq` and `bullmq` (the underlying library).
- Redis is an in-memory data store; BullMQ uses it as the backend for queue state. They serve a different purpose than DynamoDB — DDB persists durable business records (KB documents, chat sessions, etc.); Redis holds transient queue coordination state (which jobs are pending, which are running, retry counts).

Key contracts (locked by the user before this brief — do not relitigate):

**HTTP API changes:**

- `POST /knowledge-base/documents` now returns **202 Accepted** (was 201 Created):
  ```json
  {
    "document_id": "01K...",
    "status": "pending",
    "_createdAt_": "2026-04-26T..."
  }
  ```
  No `chunk_count` (unknown until processing completes). No `_lastUpdated_` (same as `_createdAt_` at this point).

- New endpoint: `GET /knowledge-base/documents?account_id=A%23<ulid>&external_id=<id>` returns the full DynamoDB record:
  ```json
  {
    "document_id": "01K...",
    "account_id": "01K...",
    "external_id": "...",
    "title": "...",
    "source_type": "pdf",
    "mime_type": "application/pdf",
    "chunk_count": 15,
    "status": "ready",
    "_createdAt_": "...",
    "_lastUpdated_": "...",
    "error_summary": "..." (only present when status === "failed")
  }
  ```
  - HTTP 200 on found.
  - HTTP 404 on not found (no record exists for that pair).
  - HTTP 400 on missing/invalid query params.

- `DELETE /knowledge-base/documents` is **unchanged** — stays synchronous, still returns 204.

**Status state machine on the DDB record:**

- `status: "pending"` — record created at POST time; job is in the queue but worker hasn't started.
- `status: "processing"` — worker has picked up the job and is running the pipeline.
- `status: "ready"` — pipeline completed successfully; `chunk_count` is set; `_lastUpdated_` advances.
- `status: "failed"` — pipeline failed after all retries; `error_summary` is set with a short safe message (NEVER raw error objects, NEVER API keys); `_lastUpdated_` advances.

**Job lifecycle (BullMQ):**

- Queue name: `knowledge-base-ingestion`.
- Job payload: `{ account_id, external_id, title, text, source_type, mime_type?, document_id }` — every field needed to run the pipeline.
- The `document_id` is generated/looked-up at POST time (NOT at processing time) so the DDB record can be written immediately and the upstream can poll on it from the moment 202 returns.
- For UPDATE path (existing `(account_id, external_id)`): the existing `document_id` is reused at POST time via the same `lookupExistingDocument` mechanism from Phase 7a. The job payload carries the reused id.
- 3 automatic retries with exponential backoff (1s, 5s, 25s) on transient failures (Voyage outage, Qdrant outage, network).
- DO NOT retry on `BadRequestException` (validation failures from inside the pipeline) — those are deterministic and would just fail again. Mark job as failed immediately.
- After all retries exhausted, the worker writes `status: "failed"` with `error_summary` to the DDB record.

**Worker concurrency:**

- ONE job at a time per worker process. Sequential. Keeps memory and external-API concurrency predictable.
- Multi-worker scaling is OUT OF SCOPE — Phase 8 concern.

**Redis configuration:**

- New env vars: `REDIS_HOST` (default `localhost`), `REDIS_PORT` (default `6379`).
- New service in `docker-compose.yml`: `redis` using the official `redis:7-alpine` image (or pin to a current stable tag — confirm via Docker Hub at planning time).
- Volume mount for persistence so dev queue state survives restarts (BullMQ depends on Redis having the job state).
- If Redis is unreachable on POST, return HTTP 503. The job can't be queued; the work can't happen.
- If Redis goes down mid-processing, BullMQ retries when Redis comes back; jobs in-flight may need to be re-attempted — accept the temporary degradation.

**De-duplication of concurrent updates:**

- DEFERRED to Phase 8. If two POSTs arrive for the same `(account_id, external_id)` within seconds, both jobs queue and both run. Last-one-wins on DDB. Documented as a known limitation. Add to `phase-8-considerations.md` if not already there.

**Status endpoint authentication:**

- No auth in this phase (matches the rest of the KB endpoints' current convention). Phase 8 adds internal-API auth across all KB endpoints.

Out of scope for Phase 7c (do not add these):
- Multi-worker scaling — Phase 8.
- De-dup by `(account_id, external_id)` job-key — Phase 8.
- Sentry/Slack alerts on job failures — Phase 8.
- Manual retry endpoint for failed jobs — future.
- Dead-letter queue inspection UI — future.
- Any change to DELETE behavior — stays sync.
- Any change to retrieval — `lookup_knowledge_base` tool unchanged.
- A "list all documents for an account" endpoint — future "KB admin" phase.


STEP 1 — ARCHITECTURE PLANNING
Use the arch-planner agent to analyze the codebase and produce a structured implementation plan.

Task specifics for this plan:

1. Read the brief in full. Read `docs/knowledge-base/data-flows.md` to understand the current synchronous shape.

2. Study the existing patterns the new code must mirror:
   - `src/services/knowledge-base-ingestion.service.ts` — the existing `ingestDocument` method becomes the body of the worker. Its signature and behavior should not change; it just stops being called directly from the controller.
   - `src/services/knowledge-base-ingestion.service.spec.ts` — existing test patterns.
   - `src/controllers/knowledge-base.controller.ts` — POST handler will be reshaped to enqueue + write pending record. New GET handler added.
   - `src/types/KnowledgeBase.ts` — status enum, status response type, error_summary field.
   - `src/validation/knowledge-base.schema.ts` — new query schema for the GET status endpoint.
   - `src/app.module.ts` — register BullModule and the new processor.
   - Log-line format: bracketed `[key=value key=value]` everywhere.

3. Verify the BullMQ JS SDK and `@nestjs/bullmq` integration against live documentation. Your training data may be unreliable. Confirm:
   - Current stable version of `@nestjs/bullmq` and `bullmq` packages.
   - The decorator pattern for defining a processor (e.g., `@Processor("knowledge-base-ingestion")`, `@OnQueueActive`, etc. — names may have changed in BullMQ vs. legacy Bull).
   - The signature for `BullModule.forRoot()` and `BullModule.registerQueue()` in NestJS.
   - The job-options API for retries with exponential backoff (`attempts`, `backoff: { type: "exponential", delay: ... }`).
   - The `Queue.add()` signature and how to pass a job id (used for telemetry, not de-dup in this phase).
   - Sources: `https://docs.nestjs.com/techniques/queues`, the `@nestjs/bullmq` GitHub repo, `https://docs.bullmq.io/`.

4. Verify the current stable `redis:N-alpine` image tag via Docker Hub. Pin to a specific tag (NOT `latest`).

5. Produce a detailed implementation plan covering ALL of these sections:
   - **Overview** — one paragraph.
   - **Affected files / modules** — every file that will be created or modified, with one-line note per file.
   - **BullMQ + NestJS verification findings** — exact decorator names, exact job-options shape, exact module registration shape. Cite source URLs.
   - **Redis docker-compose entry** — exact service block with pinned image tag, port mapping, volume.
   - **Type changes** — exact final shapes for the status enum and the GET response DTO.
   - **POST controller refactor** — exact step-by-step of the new handler:
     1. Validate input.
     2. Strip A# prefix.
     3. Lookup existing document by (account_id, external_id).
     4. Generate or reuse document_id; capture _createdAt_.
     5. Write DDB record with status: "pending" via PutCommand.
     6. Enqueue BullMQ job with the full payload.
     7. Return 202 with { document_id, status: "pending", _createdAt_ }.
     - On Redis failure at step 6: roll back the DDB record? Or leave the pending record orphaned? Recommendation: leave it (deletion is its own pipeline; orphaned pending records are recoverable by re-POSTing). Document the choice.
   - **GET controller handler** — exact shape, query param validation, lookup mechanism, response shape.
   - **Worker / processor design** — class structure, decorator pattern, the body that calls the existing `ingestDocument` logic, status transitions written to DDB at each stage (pending → processing on start, processing → ready/failed at end).
   - **Status update mechanism** — UpdateCommand (not PutCommand) on the DDB record so we don't accidentally overwrite other fields. Specify the exact UpdateExpression for each transition.
   - **Retry configuration** — exact BullMQ options object: `attempts: 4` (initial + 3 retries), exponential backoff with the brief's specified delays.
   - **Error handling** — distinguish retryable transients from non-retryable validation failures. The plan must specify HOW the worker decides which is which (e.g., catch BadRequestException specifically and don't re-throw / mark job as failed).
   - **Step-by-step implementation order** — file-by-file, granular enough that the implementer can execute without re-thinking.
   - **Risks and edge cases** — at minimum: Redis down at POST time, Redis down mid-processing, worker crashes mid-job, race between two updates for same (account_id, external_id), DDB write succeeds but Redis enqueue fails, status endpoint receives partially-written record (e.g., status: "processing" but worker just crashed — how does this self-heal?).
   - **Testing strategy** — list every new test case AND every existing test that needs assertion updates. Use `bullmq` mocks or in-memory mode for tests; do NOT require a real Redis to run the suite.
   - **Data-flows doc updates** — exact text to add to `docs/knowledge-base/data-flows.md` reflecting the new async shape of Flow 1 and Flow 3. Keep the existing diagrams; replace them with the new async ones.
   - **Out-of-scope confirmations.**

6. Write your plan to `docs/knowledge-base/tasks/phase-7c-redis-bullmq-async-queue-plan.md`.

7. Return a concise summary (under 600 words) including:
   - Path to the plan file
   - 5–7 key decisions or clarifications you made (especially anything you confirmed via live BullMQ/NestJS docs that affects the plan)
   - Any risks or unknowns the orchestrator should flag to the user — especially around: the decision to roll back or orphan the DDB record on Redis-enqueue failure, the worker-crash-mid-processing self-healing story, and any BullMQ API changes that diverged from the brief's assumptions.

Pause after producing the plan so the orchestrator can get user approval before Step 2.


STEP 2 — IMPLEMENTATION
Use the code-implementer agent to implement the approved plan.

Implementation details for this task:
- Add `@nestjs/bullmq` and `bullmq` dependencies. Pin to versions confirmed by the arch-planner.
- Add the Redis service to `docker-compose.yml`.
- Add Redis env vars to `.env.local` and the env schema.
- Refactor the controller's POST handler. Reshape the existing `ingestDocument` method (or split into "queue" vs "process" methods) so the worker calls the same pipeline code.
- Implement the new GET status endpoint.
- Implement the BullMQ processor.
- Update the data-flows doc.
- Run `npm run build` and `npm test` before returning. Both must be clean.
- Commit on master. Suggested subject: `feat(kb): make ingestion async via Redis + BullMQ queue`. **Do NOT add `Co-Authored-By:` or credit Claude.**

Implementation requirements:
- follow the plan produced by the arch-planner agent
- modify or create only the necessary files
- respect existing architecture and coding patterns
- focus on correctness first (style will be handled later)


STEP 3 — STYLE REFACTOR
Use the style-refactor agent to refactor the implementation according to the rules defined in `.claude/instructions/style-enforcer.md`.

Style refactor specifics:
- The new processor class follows existing service style (constructor DI, logger, named constants, sanitized error handling).
- Bracketed `[key=value]` log format throughout.
- Named constants for the queue name, retry attempt count, backoff delays.
- No `any`, no inline type annotations TypeScript can infer, no dead code.

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
- Run `npm test`. Baseline before this phase: 349 tests passing. Phase 7c adds tests for the queue handler, the processor, the status endpoint, and the retry/failure paths.
- Report exact pass/fail counts.
- BullMQ should be mocked in unit tests — no real Redis required.

Testing requirements:
- run the project's standard test command
- report all failing tests clearly
- summarize results
- do not modify code or attempt fixes


STEP 5 — CODE REVIEW
Use the code-reviewer agent to review the implementation.

Review focus for this task:
- **POST returns 202 immediately.** No code path lets the controller block on the actual pipeline.
- **DDB record written with status: "pending" BEFORE the BullMQ enqueue.** If the order is reversed, a job could process before the record exists and fail to find its target.
- **Worker writes status transitions correctly:** pending → processing on start, processing → ready or failed at end. Verify by reading the actual processor code.
- **Retry policy correct:** 3 retries, exponential backoff per the brief; BadRequestException (or whatever validation-failure type the plan settled on) is NOT retried.
- **Error_summary on failed status is sanitized:** no API keys, no raw error objects, no Voyage/Qdrant error bodies.
- **GET status endpoint correctly returns 404 when not found, 400 on missing/invalid query params, 200 with the full record otherwise.**
- **DELETE is unchanged (still synchronous, still returns 204).**
- **Per-account invariant respected:** every Qdrant operation in the worker still carries account_id filter (Phase 4–7a guarantee preserved through the refactor).
- **Pipeline behavior unchanged:** the worker runs the exact same chunk → enrich → embed → write logic. No subtle reordering, no skipped steps.
- **Data-flows doc updated.**
- **Out-of-scope respected:** no Sentry, no manual-retry endpoint, no de-dup, no multi-worker, no auth additions.

Review requirements:
- verify correctness of the implementation
- confirm alignment with the architectural plan
- evaluate maintainability, security, and performance
- ensure style refactor did not alter functionality
- report issues using structured review feedback
